import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetAuthUser,
  mockRequireRoleForRequest,
  mockCheckRateLimit,
  mockWithRlsContext,
  mockGetCompany,
  mockListSocialAccounts,
  mockUpsertSocialAccount,
} = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockWithRlsContext: vi.fn(async (_companyId: string, fn: () => Promise<Response>) => fn()),
  mockGetCompany: vi.fn(),
  mockListSocialAccounts: vi.fn(),
  mockUpsertSocialAccount: vi.fn(),
}));

let insideRls = false;
const getCompanyInsideRlsCalls: boolean[] = [];

vi.mock("@/lib/session", () => ({
  getAuthUser: mockGetAuthUser,
  requireRoleForRequest: mockRequireRoleForRequest,
  unauthorized: () => new Response("unauthorized", { status: 401 }),
  forbidden: () => new Response("forbidden", { status: 403 }),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mockCheckRateLimit,
  rateLimitExceeded: (retryAfterSeconds: number) => new Response(String(retryAfterSeconds), { status: 429 }),
}));

vi.mock("@/lib/with-rls", () => ({
  withRlsContext: mockWithRlsContext,
}));

vi.mock("@/lib/store", () => ({
  store: {
    getCompany: mockGetCompany,
    listSocialAccounts: mockListSocialAccounts,
    upsertSocialAccount: mockUpsertSocialAccount,
  },
}));

import { GET, POST } from "./route";

describe("/api/social/accounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insideRls = false;
    getCompanyInsideRlsCalls.length = 0;
    mockGetAuthUser.mockResolvedValue({ id: "user_1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });
    mockCheckRateLimit.mockResolvedValue({ ok: true });
    mockWithRlsContext.mockImplementation(async (_companyId: string, fn: () => Promise<Response>) => {
      insideRls = true;
      try {
        return await fn();
      } finally {
        insideRls = false;
      }
    });
    mockGetCompany.mockImplementation(async () => {
      getCompanyInsideRlsCalls.push(insideRls);
      return { id: "co_1" };
    });
    mockListSocialAccounts.mockResolvedValue([]);
    mockUpsertSocialAccount.mockResolvedValue({
      id: "socacct_1",
      companyId: "co_1",
      platform: "x",
      status: "active",
      externalAccountId: "acct_1",
      externalHandle: "@trent",
      displayName: "Trent",
      scopes: ["post:write"],
      credentialsRef: "cred_1",
      autoPublishEnabled: false,
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:00.000Z",
    });
  });

  it("GET enforces auth, viewer role, rate limit, and RLS", async () => {
    const res = await GET(new Request("http://x/api/social/accounts?companyId=co_1"));

    expect(res.status).toBe(200);
    expect(mockGetAuthUser).toHaveBeenCalled();
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("user_1", "viewer", { companyId: "co_1" });
    expect(mockCheckRateLimit).toHaveBeenCalledWith("user_1", "co_1");
    expect(mockWithRlsContext).toHaveBeenCalledWith("co_1", expect.any(Function));
    expect(callOrder(mockRequireRoleForRequest)).toBeLessThan(callOrder(mockWithRlsContext));
    expect(callOrder(mockCheckRateLimit)).toBeLessThan(callOrder(mockWithRlsContext));
    expect(getCompanyInsideRlsCalls).toEqual([true]);
  });

  it("POST enforces auth, member role, rate limit, and RLS", async () => {
    const res = await POST(
      jsonRequest({
        companyId: "co_1",
        platform: "x",
        externalAccountId: "acct_1",
        externalHandle: "@trent",
        displayName: "Trent",
        scopes: ["post:write"],
      }),
    );

    expect(res.status).toBe(201);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("user_1", "member", { companyId: "co_1" });
    expect(mockCheckRateLimit).toHaveBeenCalledWith("user_1", "co_1");
    expect(mockWithRlsContext).toHaveBeenCalledWith("co_1", expect.any(Function));
    expect(callOrder(mockRequireRoleForRequest)).toBeLessThan(callOrder(mockWithRlsContext));
    expect(callOrder(mockCheckRateLimit)).toBeLessThan(callOrder(mockWithRlsContext));
    expect(mockUpsertSocialAccount).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "co_1",
      platform: "x",
      externalAccountId: "acct_1",
      autoPublishEnabled: false,
    }));
    expect(getCompanyInsideRlsCalls).toEqual([true]);
  });
});

function jsonRequest(body: Record<string, unknown>) {
  return new Request("http://x/api/social/accounts", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function callOrder(mock: { mock: { invocationCallOrder: number[] } }) {
  return mock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY;
}
