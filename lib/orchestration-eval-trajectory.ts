/**
 * lib/orchestration-eval-trajectory.ts — orchestration guide Task 2.2 (part 1).
 *
 * A trajectory eval asserts on the PATH a run took (plan → execute → critic →
 * consolidate), not just its final text: did the validator-shaped DAG hold,
 * did the same work get done twice, did irreversible work sneak past its
 * gate, did the run reach a terminal event.
 *
 * Results are additive and start out non-blocking (the quarantine posture):
 * the integration suite attaches them to each eval result so regressions are
 * visible in the scorecard output without changing the pass-rate metric.
 * Promotion to blocking happens per-assertion once an assertion has proven
 * stable against real trajectories.
 */
import { store } from "@/lib/store";
import { validateOrchestrationPlanDag } from "@/lib/orchestration-eval";
import type { OrchestrationStep } from "@/lib/orchestrator-runtime";
import type { OrchestratorEvent, OrchestratorRun, OrchestratorStep } from "@/lib/types";

export type OrchestrationTrajectory = {
  run?: OrchestratorRun;
  steps: OrchestratorStep[];
  events: OrchestratorEvent[];
};

export type TrajectoryAssertionResult = {
  id: string;
  description: string;
  pass: boolean;
  detail?: string;
};

export type TrajectoryCaseResult = {
  objectiveId: string;
  passed: boolean;
  assertions: TrajectoryAssertionResult[];
  failureTags: string[];
};

const TERMINAL_EVENT_KINDS = new Set(["run_done", "run_failed", "run_cancelled"]);
const APPROVAL_EVENT_KINDS = new Set(["step_awaiting_approval", "step_approved", "run_awaiting_approval"]);

/** Load the persisted path of a run for trajectory evaluation. */
export async function loadOrchestrationTrajectory(runId: string): Promise<OrchestrationTrajectory> {
  const [run, steps, events] = await Promise.all([
    store.getOrchestratorRun(runId),
    store.listOrchestratorSteps(runId),
    store.listOrchestratorEvents(runId),
  ]);
  return { run: run ?? undefined, steps, events };
}

function toPlanSteps(steps: OrchestratorStep[]): OrchestrationStep[] {
  return steps.map((step) => ({
    id: step.id,
    title: step.title,
    rationale: step.rationale,
    agentRole: step.agentRole,
    dependsOn: step.dependsOn,
    expectedOutput: step.expectedOutput,
    riskLevel: step.riskLevel as OrchestrationStep["riskLevel"],
    needsApproval: step.needsApproval,
  }));
}

function assertValidatorPassed(trajectory: OrchestrationTrajectory): TrajectoryAssertionResult {
  const dag = validateOrchestrationPlanDag(toPlanSteps(trajectory.steps));
  return {
    id: "validator_passed",
    description: "The executed plan satisfies the DAG validator (no cycles, no dangling dependencies).",
    pass: dag.valid,
    detail: dag.valid ? undefined : dag.issues.join("; "),
  };
}

function assertNoDuplicateWork(trajectory: OrchestrationTrajectory): TrajectoryAssertionResult {
  const seen = new Map<string, number>();
  for (const step of trajectory.steps) {
    if (step.status === "blocked") continue;
    const key = `${step.agentRole}::${step.title.trim().toLowerCase()}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const duplicates = [...seen.entries()].filter(([, count]) => count > 1).map(([key]) => key);
  return {
    id: "no_duplicate_work",
    description: "No two actionable steps assign the same work (same seat + title) — duplicate artifacts indicate a planner/replan loop.",
    pass: duplicates.length === 0,
    detail: duplicates.length ? `duplicated: ${duplicates.join(", ")}` : undefined,
  };
}

function assertIrreversibleWorkGated(trajectory: OrchestrationTrajectory): TrajectoryAssertionResult {
  const approvalEventStepIds = new Set(
    trajectory.events.filter((event) => APPROVAL_EVENT_KINDS.has(event.kind)).map((event) => event.stepId),
  );
  const runPausedForApproval = trajectory.events.some((event) => event.kind === "run_awaiting_approval");
  const ungated = trajectory.steps.filter((step) => {
    if (!step.needsApproval) return false;
    if (step.status === "blocked" || step.status === "awaiting_approval") return false;
    const executed = step.status === "completed" || step.status === "failed" || step.status === "running";
    if (!executed) return false;
    return !step.approvalId && !approvalEventStepIds.has(step.id) && !runPausedForApproval;
  });
  return {
    id: "irreversible_work_gated",
    description: "Every executed step that declared needsApproval shows an approval trace (approvalId or an approval event) — irreversible work never runs ungated.",
    pass: ungated.length === 0,
    detail: ungated.length ? `ungated steps: ${ungated.map((step) => step.title).join(", ")}` : undefined,
  };
}

function assertTerminalEventEmitted(trajectory: OrchestrationTrajectory): TrajectoryAssertionResult {
  const terminalStatuses = new Set(["completed", "failed", "cancelled"]);
  const runIsTerminal = Boolean(trajectory.run && terminalStatuses.has(trajectory.run.status));
  if (!runIsTerminal) {
    // A run paused on approvals is a legitimate non-terminal resting state.
    return {
      id: "terminal_event_emitted",
      description: "A terminal run records a terminal event (run_done/run_failed/run_cancelled).",
      pass: true,
      detail: "run not terminal — assertion not applicable",
    };
  }
  const hasTerminalEvent = trajectory.events.some((event) => TERMINAL_EVENT_KINDS.has(event.kind));
  return {
    id: "terminal_event_emitted",
    description: "A terminal run records a terminal event (run_done/run_failed/run_cancelled).",
    pass: hasTerminalEvent,
    detail: hasTerminalEvent ? undefined : `run status is ${trajectory.run?.status} but no terminal event was persisted`,
  };
}

export const DEFAULT_TRAJECTORY_ASSERTIONS: Array<(trajectory: OrchestrationTrajectory) => TrajectoryAssertionResult> = [
  assertValidatorPassed,
  assertNoDuplicateWork,
  assertIrreversibleWorkGated,
  assertTerminalEventEmitted,
];

export function evaluateOrchestrationTrajectory(
  objectiveId: string,
  trajectory: OrchestrationTrajectory,
  assertions = DEFAULT_TRAJECTORY_ASSERTIONS,
): TrajectoryCaseResult {
  const results = assertions.map((assertion) => assertion(trajectory));
  const failed = results.filter((result) => !result.pass);
  return {
    objectiveId,
    passed: failed.length === 0,
    assertions: results,
    failureTags: failed.map((result) => `trajectory_${result.id}`),
  };
}
