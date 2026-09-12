import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetAuthUser,
  mockRequireRoleForRequest,
  mockCheckRateLimit,
  mockWithRlsContext,
  mockRunDailyOptimization,
} = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockWithRlsContext: vi.fn(async (_companyId: string, fn: () => Promise<Response>) => fn()),
  mockRunDailyOptimization: vi.fn(),
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

vi.mock("@/lib/marketing/optimizer", () => ({
  runDailyOptimization: mockRunDailyOptimization,
}));

import { POST } from "./route";

describe("POST /api/marketing/optimize/daily", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthUser.mockResolvedValue({ id: "user_1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "admin" });
    mockCheckRateLimit.mockResolvedValue({ ok: true });
    mockWithRlsContext.mockImplementation(async (_companyId: string, fn: () => Promise<Response>) => fn());
    mockRunDailyOptimization.mockResolvedValue({
      idempotent: false,
      run: { id: "opt_1", status: "completed" },
      decisions: [{ type: "pause_loser", campaignId: "camp_1" }],
    });
  });

  it("requires auth, admin role, rate limit, RLS, and runs daily optimization", async () => {
    const res = await POST(jsonRequest({
      companyId: "co_1",
      marketingAccountId: "ma_1",
      runDate: "2026-05-29",
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.run.id).toBe("opt_1");
    expect(mockGetAuthUser).toHaveBeenCalled();
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("user_1", "admin", { companyId: "co_1" });
    expect(mockCheckRateLimit).toHaveBeenCalledWith("user_1", "co_1");
    expect(mockWithRlsContext).toHaveBeenCalledWith("co_1", expect.any(Function));
    expect(mockRunDailyOptimization).toHaveBeenCalledWith({
      companyId: "co_1",
      marketingAccountId: "ma_1",
      runDate: "2026-05-29",
    });
    expect(callOrder(mockRequireRoleForRequest)).toBeLessThan(callOrder(mockWithRlsContext));
    expect(callOrder(mockCheckRateLimit)).toBeLessThan(callOrder(mockWithRlsContext));
  });

  it("returns existing optimization run responses as successful idempotent calls", async () => {
    mockRunDailyOptimization.mockResolvedValue({
      idempotent: true,
      run: { id: "opt_existing", status: "completed" },
      decisions: [],
    });

    const res = await POST(jsonRequest({
      companyId: "co_1",
      marketingAccountId: "ma_1",
      runDate: "2026-05-29",
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.idempotent).toBe(true);
    expect(body.run.id).toBe("opt_existing");
  });

  it("rejects malformed input before RLS", async () => {
    const res = await POST(jsonRequest({
      companyId: "co_1",
      marketingAccountId: "ma_1",
      runDate: "May 29",
    }));

    expect(res.status).toBe(400);
    expect(mockWithRlsContext).not.toHaveBeenCalled();
    expect(mockRunDailyOptimization).not.toHaveBeenCalled();
  });

  it("returns 401 when unauthenticated", async () => {
    mockGetAuthUser.mockResolvedValue(null);
    const res = await POST(jsonRequest({
      companyId: "co_1",
      marketingAccountId: "ma_1",
      runDate: "2026-05-29",
    }));
    expect(res.status).toBe(401);
  });

  it("returns 403 unless the caller is an admin", async () => {
    mockRequireRoleForRequest.mockResolvedValue({ ok: false, reason: "insufficient_role" });
    const res = await POST(jsonRequest({
      companyId: "co_1",
      marketingAccountId: "ma_1",
      runDate: "2026-05-29",
    }));
    expect(res.status).toBe(403);
  });

  it("returns 429 when rate limited", async () => {
    mockCheckRateLimit.mockResolvedValue({ ok: false, retryAfterSeconds: 30 });
    const res = await POST(jsonRequest({
      companyId: "co_1",
      marketingAccountId: "ma_1",
      runDate: "2026-05-29",
    }));
    expect(res.status).toBe(429);
  });
});

function jsonRequest(body: Record<string, unknown>) {
  return new Request("http://x/api/marketing/optimize/daily", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function callOrder(mock: { mock: { invocationCallOrder: number[] } }) {
  return mock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY;
}
