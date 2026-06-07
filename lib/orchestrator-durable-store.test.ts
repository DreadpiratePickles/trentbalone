import { describe, expect, it } from "vitest";
import { store } from "@/lib/store";
import { approveStep, cancelOrchestration, rejectStep } from "@/lib/orchestrator";
import { makeId } from "@/lib/utils";

describe("durable orchestrator store", () => {
  it("persists orchestration runs, steps, and replayable events", async () => {
    const company = await store.createCompany({
      name: `Durable Orc ${makeId("test")}`,
      brief: { vision: "persist orchestrator state" },
    });

    const run = await store.createOrchestratorRun({
      id: makeId("orc"),
      companyId: company.id,
      objective: "Build a notes app",
      trigger: "manual",
      status: "planning",
      modelPolicy: { planner: "gpt-5.2", specialist: "gpt-4.1-mini" },
      budgetCents: 250,
      costCents: 0,
      summary: undefined,
      cycleId: undefined,
    });

    const step = await store.upsertOrchestratorStep({
      id: "s1",
      runId: run.id,
      companyId: company.id,
      seq: 1,
      title: "Build product slice",
      rationale: "Engineer owns app builds",
      agentRole: "engineer",
      dependsOn: [],
      expectedOutput: "Working preview and files",
      riskLevel: "medium",
      needsApproval: false,
      status: "pending",
    });

    await store.appendOrchestratorEvent({
      runId: run.id,
      companyId: company.id,
      kind: "step_output",
      stepId: step.id,
      payload: { step: { id: step.id, output: "Preview verified" } },
    });

    await store.updateOrchestratorRun(run.id, {
      status: "completed",
      summary: "CEO final review: app verified",
      completedAt: "2026-06-04T12:00:00.000Z",
    });

    const replay = await store.getOrchestratorRun(run.id);
    const runs = await store.listOrchestratorRuns(company.id);
    const steps = await store.listOrchestratorSteps(run.id);
    const events = await store.listOrchestratorEvents(run.id);

    expect(runs[0].id).toBe(run.id);
    expect(replay?.status).toBe("completed");
    expect(replay?.summary).toContain("CEO final review");
    expect(steps).toEqual([expect.objectContaining({ id: "s1", agentRole: "engineer" })]);
    expect(events).toEqual([
      expect.objectContaining({
        seq: 1,
        kind: "step_output",
        payload: expect.objectContaining({ step: expect.objectContaining({ output: "Preview verified" }) }),
      }),
    ]);
  });

  it("resolves table-backed step approvals when the live waiter is gone", async () => {
    const company = await store.createCompany({
      name: `Durable Approval ${makeId("test")}`,
      brief: { vision: "approval survives process memory loss" },
    });
    const run = await store.createOrchestratorRun({
      id: makeId("orc"),
      companyId: company.id,
      objective: "Deploy app",
      trigger: "manual",
      status: "running",
      modelPolicy: {},
      budgetCents: 250,
      costCents: 0,
      summary: undefined,
      cycleId: undefined,
    });
    const approval = await store.createApproval({
      companyId: company.id,
      action: "Deploy app",
      reason: "Needs founder approval",
      previewContent: "Deploy preview",
      previewKind: "generic",
      toolName: `orchestration:${run.id}:s1`,
    });
    await store.upsertOrchestratorStep({
      id: "s1",
      runId: run.id,
      companyId: company.id,
      seq: 1,
      title: "Deploy app",
      rationale: "External action",
      agentRole: "engineer",
      dependsOn: [],
      expectedOutput: "Deployment ready",
      riskLevel: "high",
      needsApproval: true,
      status: "blocked",
      approvalId: approval.id,
    });

    await expect(approveStep(run.id, "s1")).resolves.toBe(true);

    await expect(store.getApproval(approval.id)).resolves.toEqual(expect.objectContaining({
      status: "approved",
      resolvedAt: expect.any(String),
    }));
    await expect(store.listOrchestratorEvents(run.id)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "step_approved",
        stepId: "s1",
        payload: expect.objectContaining({
          durableFallback: true,
          approvalId: approval.id,
        }),
      }),
    ]));
  });

  it("rejects table-backed step approvals when the live waiter is gone", async () => {
    const company = await store.createCompany({
      name: `Durable Rejection ${makeId("test")}`,
      brief: { vision: "rejection survives process memory loss" },
    });
    const run = await store.createOrchestratorRun({
      id: makeId("orc"),
      companyId: company.id,
      objective: "Deploy app",
      trigger: "manual",
      status: "running",
      modelPolicy: {},
      budgetCents: 250,
      costCents: 0,
      summary: undefined,
      cycleId: undefined,
    });
    const approval = await store.createApproval({
      companyId: company.id,
      action: "Deploy app",
      reason: "Needs founder approval",
      previewContent: "Deploy preview",
      previewKind: "generic",
      toolName: `orchestration:${run.id}:s1`,
    });
    await store.upsertOrchestratorStep({
      id: "s1",
      runId: run.id,
      companyId: company.id,
      seq: 1,
      title: "Deploy app",
      rationale: "External action",
      agentRole: "engineer",
      dependsOn: [],
      expectedOutput: "Deployment ready",
      riskLevel: "high",
      needsApproval: true,
      status: "blocked",
      approvalId: approval.id,
    });

    await expect(rejectStep(run.id, "s1")).resolves.toBe(true);

    await expect(store.getApproval(approval.id)).resolves.toEqual(expect.objectContaining({
      status: "rejected",
      resolvedAt: expect.any(String),
    }));
    await expect(store.listOrchestratorSteps(run.id)).resolves.toEqual([
      expect.objectContaining({
        id: "s1",
        status: "failed",
        output: "Step rejected by founder.",
      }),
    ]);
  });

  it("cancels a persisted running run and rejects its pending approvals when live memory is gone", async () => {
    const company = await store.createCompany({
      name: `Durable Cancel ${makeId("test")}`,
      brief: { vision: "cancel survives process memory loss" },
    });
    const run = await store.createOrchestratorRun({
      id: makeId("orc"),
      companyId: company.id,
      objective: "Deploy app",
      trigger: "manual",
      status: "running",
      modelPolicy: {},
      budgetCents: 250,
      costCents: 0,
      summary: undefined,
      cycleId: undefined,
    });
    const approval = await store.createApproval({
      companyId: company.id,
      action: "Deploy app",
      reason: "Needs founder approval",
      previewContent: "Deploy preview",
      previewKind: "generic",
      toolName: `orchestration:${run.id}:s1`,
    });
    await store.upsertOrchestratorStep({
      id: "s1",
      runId: run.id,
      companyId: company.id,
      seq: 1,
      title: "Deploy app",
      rationale: "External action",
      agentRole: "engineer",
      dependsOn: [],
      expectedOutput: "Deployment ready",
      riskLevel: "high",
      needsApproval: true,
      status: "blocked",
      approvalId: approval.id,
    });

    await expect(cancelOrchestration(run.id)).resolves.toBe(true);

    await expect(store.getOrchestratorRun(run.id)).resolves.toEqual(expect.objectContaining({
      status: "cancelled",
      summary: "Run cancelled by user.",
      completedAt: expect.any(String),
    }));
    await expect(store.getApproval(approval.id)).resolves.toEqual(expect.objectContaining({
      status: "rejected",
      resolvedAt: expect.any(String),
    }));
    await expect(store.listOrchestratorEvents(run.id)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "run_cancelled",
        payload: expect.objectContaining({ durableFallback: true }),
      }),
    ]));
  });
});
