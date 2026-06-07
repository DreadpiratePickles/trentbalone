import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetAuthUser,
  mockRequireRoleForRequest,
  mockCheckRateLimit,
  mockWithRlsContext,
  mockGetCompany,
  mockListMarketingAccounts,
  mockUpsertMarketingAccount,
} = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockWithRlsContext: vi.fn(async (_companyId: string, fn: () => Promise<Response>) => fn()),
  mockGetCompany: vi.fn(),
  mockListMarketingAccounts: vi.fn(),
  mockUpsertMarketingAccount: vi.fn(),
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
    listMarketingAccounts: mockListMarketingAccounts,
    upsertMarketingAccount: mockUpsertMarketingAccount,
  },
}));

import { GET, POST } from "./route";

describe("/api/marketing/accounts", () => {
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
    mockListMarketingAccounts.mockResolvedValue([]);
    mockUpsertMarketingAccount.mockResolvedValue({
      id: "mktacct_1",
      companyId: "co_1",
      platform: "meta",
      status: "active",
      externalAccountId: "act_1",
      externalBusinessId: "biz_1",
      currency: "USD",
      dailyBudgetCents: 2500,
      paymentStatus: "ready",
      consentForServerEvents: true,
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:00.000Z",
    });
  });

  it("GET requires auth, viewer role, rate limit, and RLS", async () => {
    const res = await GET(new Request("http://x/api/marketing/accounts?companyId=co_1"));

    expect(res.status).toBe(200);
    expect(mockGetAuthUser).toHaveBeenCalled();
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("user_1", "viewer", { companyId: "co_1" });
    expect(mockCheckRateLimit).toHaveBeenCalledWith("user_1", "co_1");
    expect(mockWithRlsContext).toHaveBeenCalledWith("co_1", expect.any(Function));
    expect(callOrder(mockRequireRoleForRequest)).toBeLessThan(callOrder(mockWithRlsContext));
    expect(callOrder(mockCheckRateLimit)).toBeLessThan(callOrder(mockWithRlsContext));
    expect(mockListMarketingAccounts).toHaveBeenCalledWith("co_1");
    expect(getCompanyInsideRlsCalls).toEqual([true]);
  });

  it("POST requires member role, rate limit, and RLS before upsert", async () => {
    const res = await POST(jsonRequest({
      companyId: "co_1",
      platform: "meta",
      externalAccountId: "act_1",
      externalBusinessId: "biz_1",
      currency: "usd",
      dailyBudgetCents: 2500,
      consentForServerEvents: true,
    }));

    expect(res.status).toBe(201);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("user_1", "member", { companyId: "co_1" });
    expect(mockCheckRateLimit).toHaveBeenCalledWith("user_1", "co_1");
    expect(mockWithRlsContext).toHaveBeenCalledWith("co_1", expect.any(Function));
    expect(callOrder(mockRequireRoleForRequest)).toBeLessThan(callOrder(mockWithRlsContext));
    expect(callOrder(mockCheckRateLimit)).toBeLessThan(callOrder(mockWithRlsContext));
    expect(mockUpsertMarketingAccount).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "co_1",
      platform: "meta",
      externalAccountId: "act_1",
      currency: "USD",
      consentForServerEvents: true,
    }));
    expect(getCompanyInsideRlsCalls).toEqual([true]);
  });

  it.each([
    ["companyId", { companyId: 123 }],
    ["platform", { platform: 123 }],
    ["externalAccountId", { externalAccountId: 123 }],
    ["externalBusinessId", { externalBusinessId: 123 }],
    ["currency", { currency: 123 }],
    ["dailyBudgetCents", { dailyBudgetCents: "2500" }],
    ["consentForServerEvents", { consentForServerEvents: "true" }],
  ])("POST returns 400 when %s has an invalid type", async (_field, patch) => {
    const res = await POST(jsonRequest({
      companyId: "co_1",
      platform: "meta",
      externalAccountId: "act_1",
      externalBusinessId: "biz_1",
      currency: "USD",
      dailyBudgetCents: 2500,
      consentForServerEvents: true,
      ...patch,
    }));

    expect(res.status).toBe(400);
    expect(mockWithRlsContext).not.toHaveBeenCalled();
    expect(mockUpsertMarketingAccount).not.toHaveBeenCalled();
  });

  it("returns 401 when unauthenticated", async () => {
    mockGetAuthUser.mockResolvedValue(null);
    const res = await GET(new Request("http://x/api/marketing/accounts?companyId=co_1"));
    expect(res.status).toBe(401);
  });

  it("returns 403 when the caller lacks the required role", async () => {
    mockRequireRoleForRequest.mockResolvedValue({ ok: false, reason: "insufficient_role" });
    const res = await POST(jsonRequest({
      companyId: "co_1",
      platform: "meta",
      externalAccountId: "act_1",
      externalBusinessId: "biz_1",
      currency: "USD",
      dailyBudgetCents: 2500,
      consentForServerEvents: true,
    }));
    expect(res.status).toBe(403);
  });

  it("returns 429 when rate limited", async () => {
    mockCheckRateLimit.mockResolvedValue({ ok: false, retryAfterSeconds: 30 });
    const res = await GET(new Request("http://x/api/marketing/accounts?companyId=co_1"));
    expect(res.status).toBe(429);
  });
});

function jsonRequest(body: Record<string, unknown>) {
  return new Request("http://x/api/marketing/accounts", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function callOrder(mock: { mock: { invocationCallOrder: number[] } }) {
  return mock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY;
}
