import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetAuthUser, mockRequireRoleForRequest, mockSnapshot, mockGetOrchestratorRun } = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
  mockSnapshot: vi.fn(),
  mockGetOrchestratorRun: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getAuthUser: mockGetAuthUser,
  requireRoleForRequest: mockRequireRoleForRequest,
  unauthorized: () => new Response("u", { status: 401 }),
  forbidden: () => new Response("f", { status: 403 }),
}));

vi.mock("@/lib/orchestrator", () => ({
  getOrchestrationRunSnapshot: mockSnapshot,
}));

vi.mock("@/lib/store", () => ({
  store: { getOrchestratorRun: mockGetOrchestratorRun },
}));

import { GET } from "./route";

function get(runId?: string) {
  const url = runId
    ? `http://x/api/companies/c1/orchestrate/run-to-completion?runId=${runId}`
    : "http://x/api/companies/c1/orchestrate/run-to-completion";
  return GET(new Request(url), { params: Promise.resolve({ id: "c1" }) });
}

describe("/api/companies/[id]/orchestrate/run-to-completion", () => {
  beforeEach(() => {
    mockGetAuthUser.mockReset().mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockReset().mockResolvedValue({ ok: true, role: "viewer" });
    mockSnapshot.mockReset();
    mockGetOrchestratorRun.mockReset().mockResolvedValue({ budgetCents: 100000 });
  });

  it("403s without the viewer role", async () => {
    mockRequireRoleForRequest.mockResolvedValue({ ok: false });
    expect((await get("run1")).status).toBe(403);
  });

  it("400s without a runId", async () => {
    expect((await get()).status).toBe(400);
  });

  it("404s for a run in another company", async () => {
    mockSnapshot.mockResolvedValue({ id: "run1", companyId: "other", steps: [] });
    expect((await get("run1")).status).toBe(404);
  });

  it("returns a continue decision for an all-reversible run", async () => {
    mockSnapshot.mockResolvedValue({
      id: "run1",
      companyId: "c1",
      status: "running",
      steps: [{ id: "s1", title: "Analyze", status: "pending", needsApproval: false, riskLevel: "low", costCents: 50 }],
    });
    mockGetOrchestratorRun.mockResolvedValue({ budgetCents: 1000 });
    const res = await get("run1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.decision.action).toBe("continue");
  });

  it("returns a pause decision naming the approval-gated step", async () => {
    mockSnapshot.mockResolvedValue({
      id: "run1",
      companyId: "c1",
      status: "running",
      steps: [{ id: "deploy", title: "Deploy", status: "pending", needsApproval: true, riskLevel: "high", costCents: 0 }],
    });
    const body = await (await get("run1")).json();
    expect(body.decision.action).toBe("pause");
    expect(body.decision.blockingStepId).toBe("deploy");
  });
});
