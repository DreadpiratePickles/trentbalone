import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const { mockGetAuthUser, mockRequireRoleForRequest, mockStore } = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
  mockStore: {
    getOrchestratorRun: vi.fn(),
    listOrchestratorSteps: vi.fn(),
    listOrchestratorEvents: vi.fn(),
  },
}));

vi.mock("@/lib/session", () => ({
  getAuthUser: mockGetAuthUser,
  requireRoleForRequest: mockRequireRoleForRequest,
  unauthorized: () => new Response("u", { status: 401 }),
  forbidden: () => new Response("f", { status: 403 }),
}));

vi.mock("@/lib/store", () => ({ store: mockStore }));

import { GET } from "./route";

describe("/api/companies/[id]/orchestrate/trace", () => {
  beforeEach(() => {
    mockGetAuthUser.mockReset();
    mockRequireRoleForRequest.mockReset();
    mockStore.getOrchestratorRun.mockReset();
    mockStore.listOrchestratorSteps.mockReset();
    mockStore.listOrchestratorEvents.mockReset();
  });

  it("returns a replayable trace for a persisted orchestration run", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "viewer" });
    mockStore.getOrchestratorRun.mockResolvedValue({
      id: "orc_1",
      companyId: "co_1",
      objective: "Build launch plan",
      trigger: "manual",
      status: "completed",
      modelPolicy: {},
      budgetCents: 500,
      costCents: 22,
      summary: "CEO final summary",
      startedAt: "2026-06-04T00:00:00.000Z",
      updatedAt: "2026-06-04T00:01:00.000Z",
    });
    mockStore.listOrchestratorSteps.mockResolvedValue([
      {
        id: "step_1",
        runId: "orc_1",
        companyId: "co_1",
        seq: 1,
        title: "Research",
        rationale: "Needed",
        agentRole: "analyst",
        dependsOn: [],
        expectedOutput: "Brief",
        riskLevel: "low",
        needsApproval: false,
        status: "completed",
        output: "Trend brief ready",
        costCents: 22,
      },
    ]);
    mockStore.listOrchestratorEvents.mockResolvedValue([
      {
        id: "evt_1",
        runId: "orc_1",
        companyId: "co_1",
        seq: 1,
        kind: "step_output",
        stepId: "step_1",
        payload: { detail: "Trend brief ready" },
        createdAt: "2026-06-04T00:00:30.000Z",
      },
    ]);

    const req = new Request("http://x/api/companies/co_1/orchestrate/trace?runId=orc_1") as unknown as NextRequest;
    const res = await GET(req, {
      params: Promise.resolve({ id: "co_1" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.trace).toMatchObject({
      runId: "orc_1",
      companyId: "co_1",
      status: "completed",
      ceoSummary: "CEO final summary",
      reconnectCursor: "1",
    });
    expect(data.trace.seatReports).toEqual([
      expect.objectContaining({ seat: "analyst", output: "Trend brief ready" }),
    ]);
    // Already-terminal persisted run: trace agrees, no reconciliation needed.
    expect(data.trace.reconciled).toBe(false);
    expect(data.trace.reconciledFrom).toBe("run");
  });

  it("reconciles a stale persisted run status against the durable trace (one truth)", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "viewer" });
    // Run ROW is stale at planning, but the trace has a terminal run_done event.
    mockStore.getOrchestratorRun.mockResolvedValue({
      id: "orc_2",
      companyId: "co_1",
      objective: "Prove trace truth",
      trigger: "manual",
      status: "planning",
      modelPolicy: {},
      budgetCents: 500,
      costCents: 0,
      startedAt: "2026-06-04T00:00:00.000Z",
      updatedAt: "2026-06-04T00:00:00.000Z",
    });
    mockStore.listOrchestratorSteps.mockResolvedValue([
      {
        id: "step_1",
        runId: "orc_2",
        companyId: "co_1",
        seq: 1,
        title: "Research",
        rationale: "Needed",
        agentRole: "analyst",
        dependsOn: [],
        expectedOutput: "Brief",
        riskLevel: "low",
        needsApproval: false,
        status: "completed",
        output: "done",
      },
    ]);
    mockStore.listOrchestratorEvents.mockResolvedValue([
      { id: "evt_1", runId: "orc_2", companyId: "co_1", seq: 1, kind: "run_done", payload: { run: { status: "completed" } }, createdAt: "2026-06-04T00:01:00.000Z" },
    ]);

    const req = new Request("http://x/api/companies/co_1/orchestrate/trace?runId=orc_2") as unknown as NextRequest;
    const res = await GET(req, { params: Promise.resolve({ id: "co_1" }) });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.trace.status).toBe("completed");
    expect(data.trace.reconciled).toBe(true);
    expect(data.trace.reconciledFrom).toBe("trace");
    expect(data.trace.staleSnapshotDetected).toBe(true);
  });
});
