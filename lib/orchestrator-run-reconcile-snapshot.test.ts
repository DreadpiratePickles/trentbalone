/**
 * Integration: the run SNAPSHOT endpoint surface (getOrchestrationRunSnapshot →
 * hydrateOrchestrationRun) must report ONE truth — never a stale `planning` for a
 * run the durable trace/step state proves has finished. Uses the real in-memory
 * store; no mocks, no live providers.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { store } from "@/lib/store";
import { makeId } from "@/lib/utils";
import { getOrchestrationRunSnapshot } from "@/lib/orchestrator";
import { clearOrchestrationRunCache } from "@/lib/orchestrator-cache";
import type { OrchestratorStep } from "@/lib/types";

let companyId: string;

async function persistRun(status: string): Promise<string> {
  const runId = makeId("orc");
  await store.createOrchestratorRun({
    id: runId,
    companyId,
    objective: "Prove run-truth reconciliation",
    trigger: "manual",
    status: status as never,
    modelPolicy: {},
    budgetCents: 500,
    costCents: 0,
    summary: undefined,
  });
  return runId;
}

function step(runId: string, overrides: Partial<OrchestratorStep>): OrchestratorStep {
  return {
    id: overrides.id ?? "s1",
    runId,
    companyId,
    seq: overrides.seq ?? 1,
    title: overrides.title ?? "Step",
    rationale: "needed",
    agentRole: "analyst",
    dependsOn: overrides.dependsOn ?? [],
    expectedOutput: "Report",
    riskLevel: "low",
    needsApproval: false,
    status: "completed",
    ...overrides,
  };
}

beforeEach(async () => {
  clearOrchestrationRunCache();
  const company = await store.createCompany({
    name: `Reconcile ${makeId("test")}`,
    brief: { vision: "run truth" },
  });
  companyId = company.id;
});

afterEach(() => {
  clearOrchestrationRunCache();
});

describe("snapshot run-truth reconciliation", () => {
  it("run persisted as planning + trace completed → snapshot returns completed with reconciliation metadata", async () => {
    const runId = await persistRun("planning");
    await store.upsertOrchestratorStep(step(runId, { id: "s1", status: "completed", output: "done" }));
    await store.appendOrchestratorEvent({ runId, companyId, kind: "run_done", payload: { run: { status: "completed" } } });
    clearOrchestrationRunCache();

    const snapshot = await getOrchestrationRunSnapshot(runId);

    expect(snapshot?.status).toBe("completed");
    expect(snapshot?.reconciled).toBe(true);
    expect(snapshot?.reconciledFrom).toBe("trace");
    expect(snapshot?.staleSnapshotDetected).toBe(true);
  });

  it("run persisted as running + all steps terminal → snapshot returns terminal (from steps)", async () => {
    const runId = await persistRun("running");
    await store.upsertOrchestratorStep(step(runId, { id: "s1", seq: 1, status: "completed", output: "a" }));
    await store.upsertOrchestratorStep(step(runId, { id: "s2", seq: 2, status: "completed", output: "b" }));
    clearOrchestrationRunCache();

    const snapshot = await getOrchestrationRunSnapshot(runId);

    expect(snapshot?.status).toBe("completed");
    expect(snapshot?.reconciledFrom).toBe("steps");
    expect(snapshot?.staleSnapshotDetected).toBe(true);
  });

  it("run awaiting approval → snapshot returns awaiting_approval, not failed/lost", async () => {
    const runId = await persistRun("awaiting_approval");
    await store.upsertOrchestratorStep(step(runId, { id: "s1", seq: 1, status: "completed", output: "a" }));
    await store.upsertOrchestratorStep(step(runId, { id: "s2", seq: 2, status: "awaiting_approval", output: "gate" }));
    clearOrchestrationRunCache();

    const snapshot = await getOrchestrationRunSnapshot(runId);

    expect(snapshot?.status).toBe("awaiting_approval");
    expect(snapshot?.reconciled).toBe(false);
  });

  it("failed dependency cascade still reports failed honestly", async () => {
    const runId = await persistRun("running");
    await store.upsertOrchestratorStep(step(runId, { id: "s1", seq: 1, status: "completed", output: "a" }));
    await store.upsertOrchestratorStep(step(runId, { id: "s2", seq: 2, status: "failed", output: "provider exploded" }));
    await store.upsertOrchestratorStep(step(runId, { id: "s3", seq: 3, status: "blocked", output: "Skipped — dependency s2 failed" }));
    clearOrchestrationRunCache();

    const snapshot = await getOrchestrationRunSnapshot(runId);

    expect(snapshot?.status).toBe("failed");
    expect(snapshot?.reconciledFrom).toBe("steps");
  });

  it("no terminal trace → snapshot remains nonterminal (planning preserved)", async () => {
    const runId = await persistRun("planning");
    await store.upsertOrchestratorStep(step(runId, { id: "s1", seq: 1, status: "completed", output: "a" }));
    await store.upsertOrchestratorStep(step(runId, { id: "s2", seq: 2, status: "running" }));
    await store.upsertOrchestratorStep(step(runId, { id: "s3", seq: 3, status: "pending" }));
    clearOrchestrationRunCache();

    const snapshot = await getOrchestrationRunSnapshot(runId);

    expect(snapshot?.status).toBe("planning");
    expect(snapshot?.reconciled).toBe(false);
    expect(snapshot?.staleSnapshotDetected).toBe(false);
  });

  it("self-heals the persisted run row when a terminal trace event proves completion", async () => {
    const runId = await persistRun("planning");
    await store.upsertOrchestratorStep(step(runId, { id: "s1", status: "completed", output: "done" }));
    await store.appendOrchestratorEvent({ runId, companyId, kind: "run_done", payload: { run: { status: "completed" } } });
    clearOrchestrationRunCache();

    await getOrchestrationRunSnapshot(runId);

    const persisted = await store.getOrchestratorRun(runId);
    expect(persisted?.status).toBe("completed");
  });
});
