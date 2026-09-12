import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetAuthUser,
  mockRequireRoleForRequest,
  mockCheckRateLimit,
  mockRateLimitExceeded,
  mockWithRlsContext,
  mockGetCompany,
  mockListSocialConversations,
  mockGetSocialContact,
  mockListSocialMessagesForConversation,
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
  mockListSocialConversations: vi.fn(),
  mockGetSocialContact: vi.fn(),
  mockListSocialMessagesForConversation: vi.fn(),
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
    listSocialConversations: mockListSocialConversations,
    getSocialContact: mockGetSocialContact,
    listSocialMessagesForConversation: mockListSocialMessagesForConversation,
  },
}));

import { GET } from "./route";

describe("/api/social/inbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rlsState.active = false;
    mockGetAuthUser.mockResolvedValue({ id: "user_1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "viewer" });
    mockCheckRateLimit.mockResolvedValue({ ok: true });
    mockGetCompany.mockImplementation(async () => {
      expect(rlsState.active).toBe(true);
      return { id: "co_1" };
    });
    mockListSocialConversations.mockImplementation(async () => {
      expect(rlsState.active).toBe(true);
      return [{
        id: "socconv_1",
        companyId: "co_1",
        socialAccountId: "socacct_1",
        platform: "x",
        externalThreadId: "thread_1",
        contactId: "soccontact_1",
        status: "open",
        lastMessageAt: "2026-05-29T10:00:00.000Z",
        metadata: {},
        createdAt: "2026-05-29T10:00:00.000Z",
        updatedAt: "2026-05-29T10:00:00.000Z",
      }];
    });
    mockGetSocialContact.mockResolvedValue({
      id: "soccontact_1",
      companyId: "co_1",
      platform: "x",
      externalContactId: "x_user_1",
      handle: "@founder",
      engagementState: "engaged",
      optOutStatus: "not_opted_out",
      memory: {},
    });
    mockListSocialMessagesForConversation.mockResolvedValue([{
      id: "socmsg_1",
      companyId: "co_1",
      conversationId: "socconv_1",
      contactId: "soccontact_1",
      direction: "inbound",
      kind: "dm",
      content: "Interested",
      sentAt: "2026-05-29T10:00:00.000Z",
      metadata: {},
    }]);
  });

  it("GET enforces auth, viewer role, rate limit, and RLS before listing inbox", async () => {
    const res = await GET(new Request("http://x/api/social/inbox?companyId=co_1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("user_1", "viewer", { companyId: "co_1" });
    expect(mockCheckRateLimit).toHaveBeenCalledWith("user_1", "co_1");
    expect(mockWithRlsContext).toHaveBeenCalledWith("co_1", expect.any(Function));
    expect(mockListSocialConversations).toHaveBeenCalledWith("co_1");
    expect(body.inbox).toHaveLength(1);
    expect(body.inbox[0].latestMessage.content).toBe("Interested");
  });
});
