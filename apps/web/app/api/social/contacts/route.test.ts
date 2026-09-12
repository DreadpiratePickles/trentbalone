import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetAuthUser,
  mockRequireRoleForRequest,
  mockCheckRateLimit,
  mockRateLimitExceeded,
  mockWithRlsContext,
  mockGetCompany,
  mockListSocialContacts,
  mockGetSocialContact,
  mockUpdateSocialContact,
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
  mockListSocialContacts: vi.fn(),
  mockGetSocialContact: vi.fn(),
  mockUpdateSocialContact: vi.fn(),
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
    listSocialContacts: mockListSocialContacts,
    getSocialContact: mockGetSocialContact,
    updateSocialContact: mockUpdateSocialContact,
  },
}));

import { GET, POST } from "./route";

describe("/api/social/contacts", () => {
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
    mockListSocialContacts.mockImplementation(async () => {
      expect(rlsState.active).toBe(true);
      return [{ id: "soccontact_1", companyId: "co_1", platform: "x", memory: {} }];
    });
    mockGetSocialContact.mockResolvedValue({
      id: "soccontact_1",
      companyId: "co_1",
      platform: "x",
      externalContactId: "x_user_1",
      engagementState: "contacted",
      optOutStatus: "not_opted_out",
      memory: { notes: "Existing note" },
    });
    mockUpdateSocialContact.mockImplementation(async (_companyId, _contactId, patch) => ({
      id: "soccontact_1",
      companyId: "co_1",
      platform: "x",
      externalContactId: "x_user_1",
      engagementState: patch.engagementState ?? "contacted",
      optOutStatus: patch.optOutStatus ?? "not_opted_out",
      memory: patch.memory ?? {},
    }));
  });

  it("GET enforces auth, viewer role, rate limit, and RLS", async () => {
    const res = await GET(new Request("http://x/api/social/contacts?companyId=co_1"));

    expect(res.status).toBe(200);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("user_1", "viewer", { companyId: "co_1" });
    expect(mockCheckRateLimit).toHaveBeenCalledWith("user_1", "co_1");
    expect(mockWithRlsContext).toHaveBeenCalledWith("co_1", expect.any(Function));
    expect(mockListSocialContacts).toHaveBeenCalledWith("co_1");
  });

  it("POST updates contact memory, engagement state, and opt-out inside RLS", async () => {
    const res = await POST(jsonRequest({
      companyId: "co_1",
      contactId: "soccontact_1",
      memory: { lastIntent: "demo" },
      engagementState: "engaged",
      optOutStatus: "opted_out",
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("user_1", "member", { companyId: "co_1" });
    expect(mockCheckRateLimit).toHaveBeenCalledWith("user_1", "co_1");
    expect(mockUpdateSocialContact).toHaveBeenCalledWith("co_1", "soccontact_1", expect.objectContaining({
      engagementState: "engaged",
      optOutStatus: "opted_out",
      memory: { notes: "Existing note", lastIntent: "demo" },
    }));
    expect(body.contact.optOutStatus).toBe("opted_out");
  });
});

function jsonRequest(body: Record<string, unknown>) {
  return new Request("http://x/api/social/contacts", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
