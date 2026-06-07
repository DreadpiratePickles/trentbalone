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
    listDocuments: vi.fn(),
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

describe("/api/companies/[id]/wiki", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthUser.mockResolvedValue({ id: "user_1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true });
    mockCheckRateLimit.mockResolvedValue({ ok: true });
    mockStore.getCompany.mockResolvedValue({ id: "co_1", budgetCents: 1000 });
    mockStore.listWorkbenchSessions.mockResolvedValue([
      {
        id: "ws_1",
        companyId: "co_1",
        agentRole: "engineer",
        status: "completed",
        provider: "mock_local",
        objective: "Build wiki",
        costCents: 15,
        createdAt: "2026-05-29T00:00:00.000Z",
        updatedAt: "2026-05-29T00:05:00.000Z",
        metadata: { networkPolicy: "deny_all", allowedHosts: [], maxRuntimeSeconds: 1800, maxCostCents: 250, approvalRequiredFor: [], rollbackAvailable: true },
      },
    ]);
    mockStore.listWorkbenchEvents.mockResolvedValue([
      { id: "evt_1", companyId: "co_1", sessionId: "ws_1", type: "file", status: "completed", title: "Wiki route", content: "Edited app/api/companies/[id]/wiki/route.ts", createdAt: "2026-05-29T00:02:00.000Z" },
    ]);
    mockStore.listWorkbenchArtifacts.mockResolvedValue([]);
    mockStore.listDocuments.mockResolvedValue([
      { id: "doc_1", companyId: "co_1", type: "agent_note", title: "Architecture", content: "Wiki pages cite source files.", source: "cycle:wiki", version: 1, memoryTier: "semantic", createdAt: "2026-05-29T00:01:00.000Z" },
    ]);
    mockStore.listUsage.mockResolvedValue([{ amountCents: 25 }]);
  });

  it("uses auth, viewer RBAC, rate limit, and RLS before returning the wiki aggregate", async () => {
    const res = await GET(new Request("http://x/api/companies/co_1/wiki"), { params: Promise.resolve({ id: "co_1" }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("user_1", "viewer", { companyId: "co_1" });
    expect(mockCheckRateLimit).toHaveBeenCalledWith("user_1", "co_1");
    expect(mockWithRlsContext).toHaveBeenCalledWith("co_1", expect.any(Function));
    expect(body.wiki.tree.nodes.length).toBeGreaterThan(0);
    expect(body.wiki.pages.length).toBeGreaterThan(0);
    expect(body.wiki.diagrams[0].kind).toBe("mermaid");
    expect(body.wiki.freshness.costTelemetry.remainingCents).toBe(975);
  });

  it("fails closed when rate limited", async () => {
    mockCheckRateLimit.mockResolvedValue({ ok: false, retryAfterSeconds: 60 });

    const res = await GET(new Request("http://x/api/companies/co_1/wiki"), { params: Promise.resolve({ id: "co_1" }) });
    const body = await res.json();

    expect(res.status).toBe(429);
    expect(body.error).toBe("rate_limit_exceeded");
    expect(mockWithRlsContext).not.toHaveBeenCalled();
  });
});
