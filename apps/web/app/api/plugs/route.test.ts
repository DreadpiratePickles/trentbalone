import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetAuthUser, mockRequireRoleForRequest, mockCheckRateLimit, mockWithRlsContext } = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockWithRlsContext: vi.fn(async (_companyId: string, fn: () => Promise<Response>) => fn()),
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
vi.mock("@/lib/with-rls", () => ({ withRlsContext: mockWithRlsContext }));

import { GET } from "./route";

describe("/api/plugs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthUser.mockResolvedValue({ id: "user_1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true });
    mockCheckRateLimit.mockResolvedValue({ ok: true });
  });

  it("uses auth, viewer RBAC, rate limit, and RLS for tenant plug discovery", async () => {
    const res = await GET(new Request("http://x/api/plugs?companyId=co_1&category=operations"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("user_1", "viewer", { companyId: "co_1" });
    expect(mockCheckRateLimit).toHaveBeenCalledWith("user_1", "co_1");
    expect(mockWithRlsContext).toHaveBeenCalledWith("co_1", expect.any(Function));
    expect(body.plugs.length).toBeGreaterThan(0);
    expect(body.plugs[0]).toHaveProperty("capabilityScore");
  });

  it("filters discovery by outcome, category, creator, and eval score", async () => {
    const res = await GET(new Request("http://x/api/plugs?companyId=co_1&category=operations&creator=trent&outcome=high_completion&eval-score=0.7"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.plugs.length).toBeGreaterThan(0);
    expect(body.plugs.every((plug: {
      category: string;
      publisher: { id: string };
      completionRate: number;
      evalSet: { lastScore: number };
      marketplaceScore: number;
    }) => (
      plug.category === "operations"
      && plug.publisher.id === "trent"
      && plug.completionRate >= 0.9
      && plug.evalSet.lastScore >= 0.7
      && Number.isFinite(plug.marketplaceScore)
    ))).toBe(true);
  });
});
