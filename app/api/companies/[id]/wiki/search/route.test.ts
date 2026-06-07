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
    searchMemory: vi.fn(),
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

import { POST } from "./route";

describe("/api/companies/[id]/wiki/search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthUser.mockResolvedValue({ id: "user_1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true });
    mockCheckRateLimit.mockResolvedValue({ ok: true });
    mockStore.getCompany.mockResolvedValue({ id: "co_1", budgetCents: 1000 });
    mockStore.listWorkbenchSessions.mockResolvedValue([
      { id: "ws_1", companyId: "co_1", agentRole: "engineer", status: "completed", provider: "mock_local", objective: "Build payments", costCents: 10, createdAt: "2026-05-29T00:00:00.000Z", updatedAt: "2026-05-29T00:05:00.000Z", metadata: { networkPolicy: "deny_all", allowedHosts: [], maxRuntimeSeconds: 1800, maxCostCents: 250, approvalRequiredFor: [], rollbackAvailable: true } },
    ]);
    mockStore.listWorkbenchEvents.mockResolvedValue([
      { id: "evt_1", companyId: "co_1", sessionId: "ws_1", type: "file", status: "completed", title: "Payments route", content: "Edited app/api/payments/route.ts for idempotency.", createdAt: "2026-05-29T00:02:00.000Z" },
    ]);
    mockStore.listWorkbenchArtifacts.mockResolvedValue([]);
    mockStore.listDocuments.mockResolvedValue([
      { id: "doc_1", companyId: "co_1", type: "agent_note", title: "Payments", content: "Payments require audit logging.", source: "cycle:payments", version: 1, memoryTier: "semantic", createdAt: "2026-05-29T00:01:00.000Z" },
    ]);
    mockStore.listUsage.mockResolvedValue([{ amountCents: 25 }]);
    mockStore.searchMemory.mockResolvedValue([
      { id: "doc_1", kind: "document", title: "Payments", excerpt: "Payments require audit logging.", createdAt: "2026-05-29T00:01:00.000Z", score: 1 },
    ]);
  });

  it("returns a citation-grounded answer inside auth, RBAC, rate limit, and RLS", async () => {
    const res = await POST(new Request("http://x/api/companies/co_1/wiki/search", {
      method: "POST",
      body: JSON.stringify({ query: "Do payments need audit logging?", followUps: [{ role: "user", content: "What about payments?" }] }),
    }), { params: Promise.resolve({ id: "co_1" }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("user_1", "viewer", { companyId: "co_1" });
    expect(mockCheckRateLimit).toHaveBeenCalledWith("user_1", "co_1");
    expect(mockWithRlsContext).toHaveBeenCalledWith("co_1", expect.any(Function));
    expect(body.answer.citations.length).toBeGreaterThan(0);
    expect(body.answer.refusal).toBeUndefined();
    expect(body.analytics.rateLimitScope).toBe("company_and_key");
  });

  it("refuses answers without citations", async () => {
    mockStore.searchMemory.mockResolvedValue([]);
    mockStore.listWorkbenchEvents.mockResolvedValue([]);
    mockStore.listDocuments.mockResolvedValue([]);

    const res = await POST(new Request("http://x/api/companies/co_1/wiki/search", {
      method: "POST",
      body: JSON.stringify({ query: "Unknown roadmap detail" }),
    }), { params: Promise.resolve({ id: "co_1" }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.answer.answer).toBe("");
    expect(body.answer.refusal).toContain("No cited source");
    expect(body.answer.citations).toEqual([]);
  });

  it("rejects bad payloads and fails closed when rate limited", async () => {
    const bad = await POST(new Request("http://x/api/companies/co_1/wiki/search", {
      method: "POST",
      body: JSON.stringify({ query: "" }),
    }), { params: Promise.resolve({ id: "co_1" }) });
    expect(bad.status).toBe(400);

    mockCheckRateLimit.mockResolvedValue({ ok: false, retryAfterSeconds: 60 });
    const limited = await POST(new Request("http://x/api/companies/co_1/wiki/search", {
      method: "POST",
      body: JSON.stringify({ query: "payments" }),
    }), { params: Promise.resolve({ id: "co_1" }) });
    expect(limited.status).toBe(429);
  });
});
