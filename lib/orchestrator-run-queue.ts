import { store } from "@/lib/store";
import { nowIso } from "@/lib/utils";
import type { StepRecord } from "@/lib/orchestrator-runtime";
import { selectReadyStepsForEnqueue, type OrchestrationRun } from "@/lib/orchestrator";
import { enqueueExistingJobRunForProcessing } from "@/lib/queue";
import { emitPersistedOrcEvent, persistStep } from "@/lib/orchestrator-run-persist";
import { isFatalStepOutcome, stepSatisfiesDependency } from "@/lib/orchestrator-step-outcome";

export type OrchestrationJobAction = "plan" | "execute_step" | "consolidate";

export type OrchestrationStepPayload = {
  jobRunId: string;
  companyId: string;
  runId: string;
  action: OrchestrationJobAction;
  stepId?: string;
  timeoutMs?: number;
  delayMs?: number;
};

export function collectReadySteps(steps: StepRecord[]): StepRecord[] {
  // Satisfied = upstream COMPLETED (empty output still counts) — see
  // buildCompletedStepOutputs in orchestrator.ts.
  const outputs = Object.fromEntries(
    steps
      .filter(stepSatisfiesDependency)
      .map((step) => [step.id, step.output ?? ""]),
  );
  return steps.filter((step) => {
    if (step.status !== "pending") return false;
    return !step.dependsOn.some((dep) => !(dep in outputs));
  });
}

export function hasRemainingOrchestrationWork(steps: StepRecord[]): boolean {
  return steps.some((step) => step.status === "pending" || step.status === "running" || step.status === "awaiting_approval");
}

export function cascadeFailedDependencySteps(
  steps: StepRecord[],
  completedAt = nowIso(),
): StepRecord[] {
  const failedIds = new Set(
    steps
      .filter(isFatalStepOutcome)
      .map((step) => step.id),
  );
  const changed: StepRecord[] = [];
  let progressed = true;

  while (progressed) {
    progressed = false;
    for (const step of steps) {
      if (step.status !== "pending") continue;
      const failedDepId = step.dependsOn.find((dep) => failedIds.has(dep));
      if (!failedDepId) continue;
      const failedDep = steps.find((candidate) => candidate.id === failedDepId);
      step.status = "failed";
      step.completedAt = completedAt;
      step.output = `Skipped — dependency "${failedDep?.title ?? failedDepId}" failed or blocked.`;
      failedIds.add(step.id);
      changed.push(step);
      progressed = true;
    }
  }

  return changed;
}

export async function enqueueOrchestrationPlanJob(runId: string, companyId: string) {
  const job = await store.createJobRun({
    type: "orchestration_step",
    status: "running",
    companyId,
    trigger: "system",
    summary: `Planning orchestration ${runId}`,
    resultCount: 0,
    metadata: {
      at: nowIso(),
      runId,
      action: "plan" satisfies OrchestrationJobAction,
    },
  });
  await enqueueExistingJobRunForProcessing("orchestration_step", {
    jobRunId: job.id,
    companyId,
    runId,
    action: "plan",
  });
  return job;
}

export async function enqueueOrchestrationStepJob(runId: string, companyId: string, stepId: string) {
  const job = await store.createJobRun({
    type: "orchestration_step",
    status: "running",
    companyId,
    trigger: "system",
    summary: `Executing orchestration step ${stepId}`,
    resultCount: 0,
    metadata: {
      at: nowIso(),
      runId,
      stepId,
      action: "execute_step" satisfies OrchestrationJobAction,
    },
  });
  await enqueueExistingJobRunForProcessing("orchestration_step", {
    jobRunId: job.id,
    companyId,
    runId,
    action: "execute_step",
    stepId,
  });
  return job;
}

export async function enqueueOrchestrationConsolidateJob(runId: string, companyId: string) {
  const job = await store.createJobRun({
    type: "orchestration_step",
    status: "running",
    companyId,
    trigger: "system",
    summary: `Consolidating orchestration ${runId}`,
    resultCount: 0,
    metadata: {
      at: nowIso(),
      runId,
      action: "consolidate" satisfies OrchestrationJobAction,
    },
  });
  await enqueueExistingJobRunForProcessing("orchestration_step", {
    jobRunId: job.id,
    companyId,
    runId,
    action: "consolidate",
  });
  return job;
}

export async function enqueueReadyOrchestrationSteps(run: OrchestrationRun): Promise<void> {
  if (run.status === "cancelled" || run.status === "completed" || run.status === "failed") return;
  const cascaded = cascadeFailedDependencySteps(run.steps);
  for (const step of cascaded) {
    if (step.taskId) await store.updateTask(step.taskId, { status: "failed" }).catch(() => undefined);
    await persistStep(run, step);
    await emitPersistedOrcEvent(run, { kind: "step_end", runId: run.id, at: step.completedAt ?? nowIso(), step });
  }
  const ready = selectReadyStepsForEnqueue(run.steps);
  await Promise.all(ready.map((step) => enqueueOrchestrationStepJob(run.id, run.companyId, step.id)));
  if (!ready.length && !hasRemainingOrchestrationWork(run.steps)) {
    await enqueueOrchestrationConsolidateJob(run.id, run.companyId);
  }
}
