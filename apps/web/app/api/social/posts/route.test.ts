import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetAuthUser,
  mockRequireRoleForRequest,
  mockCheckRateLimit,
  mockRateLimitExceeded,
  mockWithRlsContext,
  mockGetCompany,
  mockListSocialPosts,
  mockGetSocialAccount,
  mockCreateSocialPost,
  mockUpdateSocialPost,
  mockCreateApproval,
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
  mockGetCompany: vi.fn(),
  mockListSocialPosts: vi.fn(),
  mockGetSocialAccount: vi.fn(),
  mockCreateSocialPost: vi.fn(),
  mockUpdateSocialPost: vi.fn(),
  mockCreateApproval: vi.fn(),
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
    getCompany: mockGetCompany,
    listSocialPosts: mockListSocialPosts,
    getSocialAccount: mockGetSocialAccount,
    createSocialPost: mockCreateSocialPost,
    updateSocialPost: mockUpdateSocialPost,
    createApproval: mockCreateApproval,
  },
}));

import { GET, POST } from "./route";

describe("/api/social/posts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rlsState.active = false;
    mockGetAuthUser.mockResolvedValue({ id: "user_1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });
    mockCheckRateLimit.mockResolvedValue({ ok: true });
    mockGetCompany.mockImplementation(async () => {
      expect(rlsState.active).toBe(true);
      return { id: "co_1" };
    });
    mockListSocialPosts.mockImplementation(async () => {
      expect(rlsState.active).toBe(true);
      return [];
    });
    mockGetSocialAccount.mockImplementation(async (companyId: string, accountId: string) => {
      expect(rlsState.active).toBe(true);
      return {
        id: accountId,
        companyId,
        platform: accountId.endsWith("x") ? "x" : "linkedin",
        status: "active",
        externalAccountId: `external_${accountId}`,
        autoPublishEnabled: false,
      };
    });
    mockCreateSocialPost.mockImplementation(async (input) => {
      expect(rlsState.active).toBe(true);
      return {
        ...input,
        id: `post_${input.platform}`,
        createdAt: "2026-05-29T00:00:00.000Z",
        updatedAt: "2026-05-29T00:00:00.000Z",
      };
    });
    mockCreateApproval.mockImplementation(async (input) => {
      expect(rlsState.active).toBe(true);
      return {
        ...input,
        id: `approval_${mockCreateApproval.mock.calls.length}`,
        status: "pending",
        createdAt: "2026-05-29T00:00:00.000Z",
      };
    });
    mockUpdateSocialPost.mockImplementation(async (id, patch) => {
      expect(rlsState.active).toBe(true);
      return {
        id,
        companyId: "co_1",
        socialAccountId: id === "post_x" ? "acct_x" : "acct_linkedin",
        platform: id === "post_x" ? "x" : "linkedin",
        status: "queued",
        content: "Launch week update",
        mediaUrls: ["https://cdn.example.com/post.png"],
        metadata: {},
        ...patch,
      };
    });
  });

  it("GET requires auth, viewer role, rate limit, and RLS", async () => {
    const res = await GET(new Request("http://x/api/social/posts?companyId=co_1"));

    expect(res.status).toBe(200);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("user_1", "viewer", { companyId: "co_1" });
    expect(mockCheckRateLimit).toHaveBeenCalledWith("user_1", "co_1");
    expect(mockWithRlsContext).toHaveBeenCalledWith("co_1", expect.any(Function));
    expect(mockListSocialPosts).toHaveBeenCalledWith("co_1");
  });

  it("POST creates adapted post drafts plus approval records without publishing", async () => {
    const res = await POST(jsonRequest({
      companyId: "co_1",
      socialAccountIds: ["acct_x", "acct_linkedin"],
      content: "Launch week update",
      mediaUrls: ["https://cdn.example.com/post.png"],
      scheduledFor: "2026-06-01T14:00:00.000Z",
    }));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("user_1", "member", { companyId: "co_1" });
    expect(mockCheckRateLimit).toHaveBeenCalledWith("user_1", "co_1");
    expect(mockCreateSocialPost).toHaveBeenCalledTimes(2);
    expect(mockCreateSocialPost).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "co_1",
      status: "queued",
      publishedAt: undefined,
      externalPostId: undefined,
    }));
    expect(mockCreateApproval).toHaveBeenCalledTimes(2);
    expect(mockCreateApproval).toHaveBeenCalledWith(expect.objectContaining({
      previewKind: "post",
    }));
    expect(mockUpdateSocialPost).toHaveBeenCalledTimes(2);
    expect(body.posts).toHaveLength(2);
    expect(body.posts[0].approvalId).toBe("approval_1");
    expect(body.approvals).toHaveLength(2);
  });

  it("defaults unscheduled posts to draft and approval-gated behavior", async () => {
    const res = await POST(jsonRequest({
      companyId: "co_1",
      socialAccountIds: ["acct_x"],
      content: "Save as draft",
    }));

    expect(res.status).toBe(201);
    expect(mockCreateSocialPost).toHaveBeenCalledWith(expect.objectContaining({
      status: "draft",
      scheduledFor: undefined,
    }));
    expect(mockCreateApproval).toHaveBeenCalledWith(expect.objectContaining({
      action: "publish_social_post",
      previewKind: "post",
    }));
  });

  it("rejects malformed input before RLS", async () => {
    const res = await POST(jsonRequest({
      companyId: "co_1",
      socialAccountIds: [],
      content: "No accounts",
    }));

    expect(res.status).toBe(400);
    expect(mockWithRlsContext).not.toHaveBeenCalled();
    expect(mockCreateSocialPost).not.toHaveBeenCalled();
  });
});

function jsonRequest(body: Record<string, unknown>) {
  return new Request("http://x/api/social/posts", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
