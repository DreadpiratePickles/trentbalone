import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetAuthUser,
  mockRequireRoleForRequest,
  mockCheckRateLimit,
  mockWithRlsContext,
  mockRunDailyAdSpendCharge,
} = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockWithRlsContext: vi.fn(async (_companyId: string, fn: () => Promise<Response>) => fn()),
  mockRunDailyAdSpendCharge: vi.fn(),
}));

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

vi.mock("@/lib/marketing/spend-loop", () => ({
  runDailyAdSpendCharge: mockRunDailyAdSpendCharge,
}));

import { POST } from "./route";

describe("POST /api/marketing/spend/daily", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthUser.mockResolvedValue({ id: "user_1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "admin" });
    mockCheckRateLimit.mockResolvedValue({ ok: true });
    mockWithRlsContext.mockImplementation(async (_companyId: string, fn: () => Promise<Response>) => fn());
    mockRunDailyAdSpendCharge.mockResolvedValue({
      idempotent: false,
      charge: {
        id: "charge_1",
        companyId: "co_1",
        billingDate: "2026-05-29",
        adSpendCents: 1234,
        platformFeeCents: 31,
        status: "succeeded",
      },
    });
  });

  it("requires auth, admin role, rate limit, RLS, and runs idempotent daily charge", async () => {
    const res = await POST(jsonRequest({
      companyId: "co_1",
      billingDate: "2026-05-29",
      feeBps: 250,
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.charge.id).toBe("charge_1");
    expect(body.idempotent).toBe(false);
    expect(mockGetAuthUser).toHaveBeenCalled();
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("user_1", "admin", { companyId: "co_1" });
    expect(mockCheckRateLimit).toHaveBeenCalledWith("user_1", "co_1");
    expect(mockWithRlsContext).toHaveBeenCalledWith("co_1", expect.any(Function));
    expect(mockRunDailyAdSpendCharge).toHaveBeenCalledWith("co_1", "2026-05-29", { feeBps: 250 });
    expect(callOrder(mockRequireRoleForRequest)).toBeLessThan(callOrder(mockWithRlsContext));
    expect(callOrder(mockCheckRateLimit)).toBeLessThan(callOrder(mockWithRlsContext));
  });

  it("returns existing charge responses as successful idempotent calls", async () => {
    mockRunDailyAdSpendCharge.mockResolvedValue({
      idempotent: true,
      charge: {
        id: "charge_existing",
        companyId: "co_1",
        billingDate: "2026-05-29",
        adSpendCents: 1234,
        platformFeeCents: 31,
        status: "succeeded",
      },
    });

    const res = await POST(jsonRequest({ companyId: "co_1", billingDate: "2026-05-29" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.idempotent).toBe(true);
    expect(body.charge.id).toBe("charge_existing");
  });

  it("rejects missing or malformed required input before RLS", async () => {
    const res = await POST(jsonRequest({ companyId: "co_1", billingDate: "05/29/2026" }));

    expect(res.status).toBe(400);
    expect(mockWithRlsContext).not.toHaveBeenCalled();
    expect(mockRunDailyAdSpendCharge).not.toHaveBeenCalled();
  });

  it("returns 401 when unauthenticated", async () => {
    mockGetAuthUser.mockResolvedValue(null);
    const res = await POST(jsonRequest({ companyId: "co_1", billingDate: "2026-05-29" }));
    expect(res.status).toBe(401);
  });

  it("returns 403 unless the caller is an admin", async () => {
    mockRequireRoleForRequest.mockResolvedValue({ ok: false, reason: "insufficient_role" });
    const res = await POST(jsonRequest({ companyId: "co_1", billingDate: "2026-05-29" }));
    expect(res.status).toBe(403);
  });

  it("returns 429 when rate limited", async () => {
    mockCheckRateLimit.mockResolvedValue({ ok: false, retryAfterSeconds: 30 });
    const res = await POST(jsonRequest({ companyId: "co_1", billingDate: "2026-05-29" }));
    expect(res.status).toBe(429);
  });
});

function jsonRequest(body: Record<string, unknown>) {
  return new Request("http://x/api/marketing/spend/daily", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function callOrder(mock: { mock: { invocationCallOrder: number[] } }) {
  return mock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY;
}
