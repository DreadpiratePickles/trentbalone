import { describe, expect, it } from "vitest";
import {
  evaluateOrchestrationTrajectory,
  loadOrchestrationTrajectory,
  type OrchestrationTrajectory,
} from "@/lib/orchestration-eval-trajectory";
import { store } from "@/lib/store";
import { makeId } from "@/lib/utils";
import type { OrchestratorEvent, OrchestratorRun, OrchestratorStep } from "@/lib/types";

function run(overrides: Partial<OrchestratorRun> = {}): OrchestratorRun {
  return {
    id: "orc_run_1",
    companyId: "co_1",
    objective: "Ship the weekly digest",
    trigger: "manual",
    status: "completed",
    modelPolicy: {},
    budgetCents: 500,
    costCents: 12,
    replanCount: 0,
    summary: "done",
    startedAt: "2026-06-12T00:00:00.000Z",
    updatedAt: "2026-06-12T00:10:00.000Z",
    ...overrides,
  };
}

function step(overrides: Partial<OrchestratorStep> = {}): OrchestratorStep {
  const id = overrides.id ?? makeId("step");
  return {
    id,
    runId: "orc_run_1",
    companyId: "co_1",
    seq: 1,
    title: "Collect metrics",
    rationale: "need data",
    agentRole: "analyst",
    dependsOn: [],
    expectedOutput: "metrics table",
    riskLevel: "low",
    needsApproval: false,
    status: "completed",
    ...overrides,
  };
}

function event(overrides: Partial<OrchestratorEvent> = {}): OrchestratorEvent {
  return {
    id: makeId("orcevent"),
    runId: "orc_run_1",
    companyId: "co_1",
    seq: 1,
    kind: "run_done",
    payload: {},
    createdAt: "2026-06-12T00:10:00.000Z",
    ...overrides,
  };
}

function trajectory(overrides: Partial<OrchestrationTrajectory> = {}): OrchestrationTrajectory {
  return {
    run: run(),
    steps: [
      step({ id: "s1", seq: 1, title: "Collect metrics" }),
      step({ id: "s2", seq: 2, title: "Write digest", agentRole: "content", dependsOn: ["s1"] }),
    ],
    events: [event()],
    ...overrides,
  };
}

describe("evaluateOrchestrationTrajectory", () => {
  it("passes a clean trajectory with no failure tags", () => {
    const result = evaluateOrchestrationTrajectory("orc_demo", trajectory());

    expect(result.passed).toBe(true);
    expect(result.failureTags).toEqual([]);
    expect(result.assertions).toHaveLength(4);
  });

  it("flags a dangling dependency through the DAG validator", () => {
    const result = evaluateOrchestrationTrajectory("orc_demo", trajectory({
      steps: [step({ id: "s1", dependsOn: ["ghost_step"] })],
    }));

    expect(result.passed).toBe(false);
    expect(result.failureTags).toContain("trajectory_validator_passed");
  });

  it("flags two actionable steps assigning the same work to the same seat", () => {
    const result = evaluateOrchestrationTrajectory("orc_demo", trajectory({
      steps: [
        step({ id: "s1", seq: 1, title: "Write digest", agentRole: "content" }),
        step({ id: "s2", seq: 2, title: "Write digest", agentRole: "content" }),
      ],
    }));

    expect(result.failureTags).toContain("trajectory_no_duplicate_work");
  });

  it("ignores duplicates when one copy is blocked (replanned-away work does not count)", () => {
    const result = evaluateOrchestrationTrajectory("orc_demo", trajectory({
      steps: [
        step({ id: "s1", seq: 1, title: "Write digest", agentRole: "content", status: "blocked" }),
        step({ id: "s2", seq: 2, title: "Write digest", agentRole: "content" }),
      ],
    }));

    expect(result.failureTags).not.toContain("trajectory_no_duplicate_work");
  });

  it("flags an executed needsApproval step with no approval trace", () => {
    const result = evaluateOrchestrationTrajectory("orc_demo", trajectory({
      steps: [step({ id: "s1", needsApproval: true, status: "completed" })],
    }));

    expect(result.failureTags).toContain("trajectory_irreversible_work_gated");
  });

  it("accepts gated work via approvalId or an approval event", () => {
    const viaApprovalId = evaluateOrchestrationTrajectory("orc_demo", trajectory({
      steps: [step({ id: "s1", needsApproval: true, status: "completed", approvalId: "appr_1" })],
    }));
    const viaEvent = evaluateOrchestrationTrajectory("orc_demo", trajectory({
      steps: [step({ id: "s1", needsApproval: true, status: "completed" })],
      events: [event(), event({ kind: "step_approved", stepId: "s1", seq: 2 })],
    }));

    expect(viaApprovalId.failureTags).not.toContain("trajectory_irreversible_work_gated");
    expect(viaEvent.failureTags).not.toContain("trajectory_irreversible_work_gated");
  });

  it("flags a terminal run that never persisted a terminal event", () => {
    const result = evaluateOrchestrationTrajectory("orc_demo", trajectory({
      events: [event({ kind: "step_end" })],
    }));

    expect(result.failureTags).toContain("trajectory_terminal_event_emitted");
  });

  it("treats a run paused on approval as not applicable for the terminal-event assertion", () => {
    const result = evaluateOrchestrationTrajectory("orc_demo", trajectory({
      run: run({ status: "awaiting_approval" }),
      events: [event({ kind: "run_awaiting_approval" })],
    }));

    expect(result.failureTags).not.toContain("trajectory_terminal_event_emitted");
  });
});

describe("loadOrchestrationTrajectory", () => {
  it("loads the persisted run, steps, and events for a run id", async () => {
    const company = await store.createCompany({ name: `Trajectory Co ${makeId("test")}`, brief: { vision: "t" } });
    const created = await store.createOrchestratorRun({
      id: makeId("orcrun"),
      companyId: company.id,
      objective: "trajectory load test",
      trigger: "manual",
      status: "completed",
      modelPolicy: {},
      budgetCents: 100,
      costCents: 0,
      summary: "ok",
    });
    await store.upsertOrchestratorStep(step({ id: makeId("step"), runId: created.id, companyId: company.id }));
    await store.appendOrchestratorEvent({ runId: created.id, companyId: company.id, kind: "run_done", payload: {} });

    const loaded = await loadOrchestrationTrajectory(created.id);

    expect(loaded.run?.id).toBe(created.id);
    expect(loaded.steps).toHaveLength(1);
    expect(loaded.events.some((item) => item.kind === "run_done")).toBe(true);
  });
});
