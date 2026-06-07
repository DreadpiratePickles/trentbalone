import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetAuthUser, mockRequireRoleForRequest, mockCheckRateLimit, mockWithRlsContext, mockStore } = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockWithRlsContext: vi.fn(async (_companyId: string, fn: () => Promise<Response>) => fn()),
  mockStore: {
    getCompany: vi.fn(),
    listWorkbenchSessions: vi.fn(),
    listWorkbenchEvents: vi.fn(),
    listWorkbenchArtifacts: vi.fn(),
    listUsage: vi.fn(),
  },
}));

vi.mock("@/lib/session", () => ({
  getAuthUser: mockGetAuthUser,
  requireRoleForRequest: mockRequireRoleForRequest,
  unauthorized: () => new Response("unauthorized", { status: 401 }),
  forbidden: () => new Response("forbidden", { status: 403 }),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mockCheckRateLimit,
  rateLimitExceeded: (retryAfterSeconds: number) => Response.json({ error: "rate_limit_exceeded", retryAfterSeconds }, { status: 429 }),
}));
vi.mock("@/lib/with-rls", () => ({ withRlsContext: mockWithRlsContext }));
vi.mock("@/lib/store", () => ({ store: mockStore }));

import { GET } from "./route";

describe("/api/companies/[id]/trenchpad", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthUser.mockResolvedValue({ id: "user_1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true });
    mockCheckRateLimit.mockResolvedValue({ ok: true });
    mockStore.getCompany.mockResolvedValue({ id: "co_1", budgetCents: 1000 });
    mockStore.listWorkbenchSessions.mockResolvedValue([{ id: "ws_1", companyId: "co_1", agentRole: "engineer", status: "running", objective: "Build", costCents: 10, createdAt: "2026-05-29T00:00:00.000Z", updatedAt: "2026-05-29T00:00:00.000Z", provider: "mock_local", metadata: { networkPolicy: "allowlist", allowedHosts: [], maxRuntimeSeconds: 3600, maxCostCents: 1000, approvalRequiredFor: [], rollbackAvailable: true } }]);
    mockStore.listWorkbenchEvents.mockResolvedValue([{ id: "evt_1", companyId: "co_1", sessionId: "ws_1", type: "plan", status: "completed", title: "Plan", content: "Do it", createdAt: "2026-05-29T00:00:00.000Z" }]);
    mockStore.listWorkbenchArtifacts.mockResolvedValue([]);
    mockStore.listUsage.mockResolvedValue([{ amountCents: 25 }]);
  });

  it("uses auth, viewer RBAC, rate limit, and RLS for aggregation", async () => {
    const res = await GET(new Request("http://x/api/companies/co_1/trenchpad"), { params: Promise.resolve({ id: "co_1" }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("user_1", "viewer", { companyId: "co_1" });
    expect(mockCheckRateLimit).toHaveBeenCalledWith("user_1", "co_1");
    expect(mockWithRlsContext).toHaveBeenCalledWith("co_1", expect.any(Function));
    expect(body.trenchpad.sessionRail.sessions).toHaveLength(1);
    expect(body.trenchpad.commandCenter.reuse).toBe("CeoCommandClient");
    expect(body.trenchpad.secrets.rendersSecretValues).toBe(false);
  });
});
