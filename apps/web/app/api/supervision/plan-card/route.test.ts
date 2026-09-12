import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetAuthUser,
  mockRequireRoleForRequest,
  mockCheckRateLimit,
  mockWithRlsContext,
  mockGetCompany,
} = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockWithRlsContext: vi.fn(async (_companyId: string, fn: () => Promise<Response>) => fn()),
  mockGetCompany: vi.fn(),
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

vi.mock("@/lib/store", () => ({
  store: {
    getCompany: mockGetCompany,
  },
}));

import { POST } from "./route";

describe("/api/supervision/plan-card", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthUser.mockResolvedValue({ id: "user_1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });
    mockCheckRateLimit.mockResolvedValue({ ok: true });
    mockGetCompany.mockResolvedValue({ id: "co_1" });
  });

  it("requires auth, member role, rate limit, and RLS before returning a dry-run plan card", async () => {
    const res = await POST(jsonRequest({
      companyId: "co_1",
      action: "github.pr.merge",
      objectType: "pull_request",
      objectId: "pr_1",
      reason: "Release approved fix",
      estimatedCostCents: 0,
      sideEffects: ["external_api_call"],
      dryRun: { summary: "Would merge PR #1", operations: ["check approvals", "merge PR"] },
    }));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("user_1", "member", { companyId: "co_1" });
    expect(mockCheckRateLimit).toHaveBeenCalledWith("user_1", "co_1");
    expect(mockWithRlsContext).toHaveBeenCalledWith("co_1", expect.any(Function));
    expect(body.planCard.status).toBe("plan_only");
    expect(body.planCard.executionAllowed).toBe(false);
    expect(body.planCard.dryRun.summary).toBe("Would merge PR #1");
  });

  it("returns 400 for malformed requests before RLS", async () => {
    const res = await POST(jsonRequest({ companyId: "co_1", action: "" }));

    expect(res.status).toBe(400);
    expect(mockWithRlsContext).not.toHaveBeenCalled();
  });
});

function jsonRequest(body: Record<string, unknown>) {
  return new Request("http://x/api/supervision/plan-card", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
