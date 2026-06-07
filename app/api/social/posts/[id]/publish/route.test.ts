import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetAuthUser,
  mockRequireRoleForRequest,
  mockCheckRateLimit,
  mockRateLimitExceeded,
  mockWithRlsContext,
  mockGetSocialPost,
  mockGetSocialAccount,
  mockGetApproval,
  mockListApprovals,
  mockUpdateSocialPost,
  mockGetSocialPlatformAdapter,
  mockPublishPost,
  rlsState,
} = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockRateLimitExceeded: vi.fn(() => new Response("rate limited", { status: 429 })),
  rlsState: { active: false },
  mockWithRlsContext: vi.fn(async (_companyId: string, fn: () => Promise<Response>) => {
    rlsState.active = true;
    try {
      return await fn();
    } finally {
      rlsState.active = false;
    }
  }),
  mockGetSocialPost: vi.fn(),
  mockGetSocialAccount: vi.fn(),
  mockGetApproval: vi.fn(),
  mockListApprovals: vi.fn(),
  mockUpdateSocialPost: vi.fn(),
  mockGetSocialPlatformAdapter: vi.fn(),
  mockPublishPost: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getAuthUser: mockGetAuthUser,
  requireRoleForRequest: mockRequireRoleForRequest,
  unauthorized: () => new Response("unauthorized", { status: 401 }),
  forbidden: () => new Response("forbidden", { status: 403 }),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mockCheckRateLimit,
  rateLimitExceeded: mockRateLimitExceeded,
}));

vi.mock("@/lib/with-rls", () => ({
  withRlsContext: mockWithRlsContext,
}));

vi.mock("@/lib/store", () => ({
  store: {
    getSocialPost: mockGetSocialPost,
    getSocialAccount: mockGetSocialAccount,
    getApproval: mockGetApproval,
    listApprovals: mockListApprovals,
    updateSocialPost: mockUpdateSocialPost,
  },
}));

vi.mock("@/lib/social/platform-adapter", () => ({
  getSocialPlatformAdapter: mockGetSocialPlatformAdapter,
}));

import { POST } from "./route";

describe("POST /api/social/posts/[id]/publish", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rlsState.active = false;
    mockGetAuthUser.mockResolvedValue({ id: "user_1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });
    mockCheckRateLimit.mockResolvedValue({ ok: true });
    mockGetSocialPost.mockImplementation(async () => {
      expect(rlsState.active).toBe(true);
      return post();
    });
    mockGetSocialAccount.mockImplementation(async () => {
      expect(rlsState.active).toBe(true);
      return account({ autoPublishEnabled: true });
    });
    mockGetApproval.mockImplementation(async () => {
      expect(rlsState.active).toBe(true);
      return { id: "approval_1", companyId: "co_1", status: "approved" };
    });
    mockListApprovals.mockImplementation(async () => {
      expect(rlsState.active).toBe(true);
      return [];
    });
    mockPublishPost.mockResolvedValue({
      externalPostId: "external_post_1",
      publishedAt: "2026-05-29T12:00:00.000Z",
    });
    mockGetSocialPlatformAdapter.mockReturnValue({
      platform: "x",
      capabilities: { posts: true },
      publishPost: mockPublishPost,
    });
    mockUpdateSocialPost.mockImplementation(async (_id, patch) => {
      expect(rlsState.active).toBe(true);
      return { ...post(), ...patch };
    });
  });

  it("requires an approved approval record before calling the adapter", async () => {
    mockGetApproval.mockResolvedValue({ id: "approval_1", companyId: "co_1", status: "pending" });

    const res = await POST(new Request("http://x/api/social/posts/post_1/publish?companyId=co_1", { method: "POST" }), {
      params: Promise.resolve({ id: "post_1" }),
    });

    expect(res.status).toBe(403);
    expect(mockPublishPost).not.toHaveBeenCalled();
    expect(mockUpdateSocialPost).not.toHaveBeenCalled();
  });

  it("blocks publishing when auto-publish is disabled even with a valid post payload", async () => {
    mockGetSocialAccount.mockResolvedValue(account({ autoPublishEnabled: false }));

    const res = await POST(new Request("http://x/api/social/posts/post_1/publish?companyId=co_1", { method: "POST" }), {
      params: Promise.resolve({ id: "post_1" }),
    });

    expect(res.status).toBe(403);
    expect(mockPublishPost).not.toHaveBeenCalled();
    expect(mockUpdateSocialPost).not.toHaveBeenCalled();
  });

  it("publishes only after auth, member role, rate limit, RLS, approval, and account checks", async () => {
    const res = await POST(new Request("http://x/api/social/posts/post_1/publish?companyId=co_1", { method: "POST" }), {
      params: Promise.resolve({ id: "post_1" }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("user_1", "member", { companyId: "co_1" });
    expect(mockCheckRateLimit).toHaveBeenCalledWith("user_1", "co_1");
    expect(mockWithRlsContext).toHaveBeenCalledWith("co_1", expect.any(Function));
    expect(mockPublishPost).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "co_1",
      socialAccountId: "acct_1",
      externalAccountId: "external_1",
      content: "Approved launch update",
    }));
    expect(mockUpdateSocialPost).toHaveBeenCalledWith("post_1", expect.objectContaining({
      status: "published",
      externalPostId: "external_post_1",
    }));
    expect(body.post.status).toBe("published");
  });

  it("requires content mission approval before publishing a mission-created social post", async () => {
    mockGetSocialPost.mockResolvedValue(post({
      metadata: { contentMissionRunId: "orc_1" },
    }));
    mockGetSocialAccount.mockResolvedValue(account({
      autoPublishEnabled: true,
      credentialsRef: "conn_x",
      scopes: ["post:write"],
    }));
    mockListApprovals.mockResolvedValue([]);

    const blocked = await POST(new Request("http://x/api/social/posts/post_1/publish?companyId=co_1", { method: "POST" }), {
      params: Promise.resolve({ id: "post_1" }),
    });
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({
      error: expect.stringContaining("approved content mission approval"),
    });
    expect(mockPublishPost).not.toHaveBeenCalled();

    mockListApprovals.mockResolvedValue([
      {
        id: "approval_mission_publish",
        companyId: "co_1",
        action: "content_mission.public_publish",
        reason: "Approve mission publish",
        status: "approved",
        createdAt: "2026-06-04T00:00:00.000Z",
        toolName: "content_mission:orc_1:action_public_publish",
      },
    ]);

    const allowed = await POST(new Request("http://x/api/social/posts/post_1/publish?companyId=co_1", { method: "POST" }), {
      params: Promise.resolve({ id: "post_1" }),
    });

    expect(allowed.status).toBe(200);
    expect(mockPublishPost).toHaveBeenCalledTimes(1);
  });

  it("returns 404 without leaking adapter calls when the post is missing", async () => {
    mockGetSocialPost.mockResolvedValue(undefined);

    const res = await POST(new Request("http://x/api/social/posts/missing/publish?companyId=co_1", { method: "POST" }), {
      params: Promise.resolve({ id: "missing" }),
    });

    expect(res.status).toBe(404);
    expect(mockPublishPost).not.toHaveBeenCalled();
  });
});

function post(overrides: Record<string, unknown> = {}) {
  return {
    id: "post_1",
    companyId: "co_1",
    socialAccountId: "acct_1",
    platform: "x",
    status: "queued",
    content: "Approved launch update",
    mediaUrls: ["https://cdn.example.com/post.png"],
    scheduledFor: "2026-06-01T14:00:00.000Z",
    approvalId: "approval_1",
    metadata: {},
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:00.000Z",
    ...overrides,
  };
}

function account(overrides: Record<string, unknown> = {}) {
  return {
    id: "acct_1",
    companyId: "co_1",
    platform: "x",
    status: "active",
    externalAccountId: "external_1",
    scopes: [],
    autoPublishEnabled: false,
    ...overrides,
  };
}
