import { store } from "@/lib/store";
import { makeId, nowIso } from "@/lib/utils";
import { auditTransition } from "@/lib/orchestrator-runtime";
import { hydrateOrchestrationRun } from "@/lib/orchestrator-run-persist";
import { selectReadyStepsForEnqueue } from "@/lib/orchestrator";
import {
  collectReadySteps,
  enqueueOrchestrationConsolidateJob,
  enqueueOrchestrationPlanJob,
  enqueueOrchestrationStepJob,
  enqueueReadyOrchestrationSteps,
  hasRemainingOrchestrationWork,
  type OrchestrationStepPayload,
} from "@/lib/orchestrator-run-queue";
import {
  processConsolidatePhase,
  processExecuteStepPhase,
  processPlanPhase,
} from "@/lib/orchestrator-run-phases";
import {
  enqueueExistingJobRunForProcessing,
  type QueueJobName,
} from "@/lib/queue";
import type { OrchestratorEvent, OrchestratorRun as OrchestratorRunRecord } from "@/lib/types";

export type { OrchestrationJobAction, OrchestrationStepPayload } from "@/lib/orchestrator-run-queue";
export { hydrateOrchestrationRun } from "@/lib/orchestrator-run-persist";
export {
  collectReadySteps,
  enqueueOrchestrationPlanJob,
  enqueueOrchestrationStepJob,
  enqueueOrchestrationConsolidateJob,
  enqueueReadyOrchestrationSteps,
  hasRemainingOrchestrationWork,
} from "@/lib/orchestrator-run-queue";

type QueueAddFunction = (type: QueueJobName, data: OrchestrationStepPayload) => Promise<void>;
const DEFAULT_STALE_ORCHESTRATION_RUN_MS = 15 * 60 * 1000;

export async function processOrchestrationStepJob(payload: OrchestrationStepPayload): Promise<void> {
  const run = await hydrateOrchestrationRun(payload.runId);
  if (!run || run.status === "cancelled" || run.status === "awaiting_approval") return;
  const company = await store.getCompany(payload.companyId);
  if (!company) throw new Error("Company not found");

  if (payload.action === "plan") {
    await processPlanPhase(run, company);
    return;
  }
  if (payload.action === "consolidate") {
    await processConsolidatePhase(run, company);
    return;
  }
  if (!payload.stepId) throw new Error("Missing stepId for execute_step action");
  await processExecuteStepPhase(run, company, payload.stepId);
}

export async function resumeOrchestrationAfterApproval(
  runId: string,
  stepId: string,
  decision: "approved" | "rejected",
): Promise<boolean> {
  const [runRecord, steps] = await Promise.all([
    store.getOrchestratorRun(runId).catch(() => undefined),
    store.listOrchestratorSteps(runId).catch(() => []),
  ]);
  if (!runRecord) return false;
  const step = steps.find((item) => item.id === stepId);
  if (!step?.approvalId) return false;
  const approval = await store.getApproval(step.approvalId).catch(() => undefined);
  if (!approval || approval.status !== "pending") return false;

  await store.resolveApproval(approval.id, decision);
  await store.updateOrchestratorRun(runId, { status: "running" }).catch(() => undefined);
  if (decision === "rejected") {
    await store.upsertOrchestratorStep({
      ...step,
      status: "failed",
      output: "Step rejected by founder.",
      completedAt: nowIso(),
    });
    await store.appendOrchestratorEvent({
      runId,
      companyId: runRecord.companyId,
      kind: "step_end",
      stepId,
      payload: {
        durableFallback: true,
        approvalId: approval.id,
        decision,
        step: { ...step, status: "failed" },
      },
    }).catch(() => undefined);
    await auditTransition(runRecord.companyId, "step_rejected", runId, `Rejected durable step ${stepId}`).catch(() => undefined);
    const run = await hydrateOrchestrationRun(runId);
    if (run) await enqueueReadyOrchestrationSteps(run);
    return true;
  }

  await store.upsertOrchestratorStep({ ...step, status: "pending" });
  await store.appendOrchestratorEvent({
    runId,
    companyId: runRecord.companyId,
    kind: "step_approved",
    stepId,
    payload: {
      durableFallback: true,
      approvalId: approval.id,
      decision,
      step: { ...step, status: "pending" },
    },
  }).catch(() => undefined);
  await auditTransition(runRecord.companyId, "step_approved", runId, `Approved durable step ${stepId}`).catch(() => undefined);
  await enqueueOrchestrationStepJob(runId, runRecord.companyId, stepId);
  return true;
}

export async function requeueRunningOrchestrationJobs(input?: {
  companyId?: string;
  addJob?: QueueAddFunction;
}): Promise<{ requeued: number; skipped: string[] }> {
  const jobs = await store.listJobRuns(input?.companyId);
  let requeued = 0;
  const skipped: string[] = [];

  for (const job of jobs) {
    if (job.type !== "orchestration_step" || job.status !== "running" || !job.companyId) continue;
    const payload = parseOrchestrationJobPayload(job);
    if (!payload) {
      skipped.push(job.id);
      continue;
    }
    if (input?.addJob) await input.addJob("orchestration_step", payload);
    else await enqueueExistingJobRunForProcessing("orchestration_step", payload);
    await store.updateJobRun(job.id, {
      metadata: {
        ...job.metadata,
        requeuedAt: nowIso(),
      },
    });
    requeued += 1;
  }

  const runRecords = await listOrchestratorRunsForReconcile(input?.companyId, jobs);
  for (const run of runRecords) {
    if (run.status !== "running" && run.status !== "planning") continue;
    const hasRunningJob = jobs.some((job) => {
      return job.type === "orchestration_step"
        && job.status === "running"
        && job.metadata?.runId === run.id;
    });
    if (hasRunningJob) continue;

    const hydrated = await hydrateOrchestrationRun(run.id);
    if (!hydrated) {
      skipped.push(run.id);
      continue;
    }

    if (hydrated.steps.some((step) => step.status === "awaiting_approval")) {
      skipped.push(run.id);
      continue;
    }

    const events = await store.listOrchestratorEvents(run.id).catch(() => []);
    if (isStaleOrchestrationRun(run, events)) {
      await markStaleOrchestrationRunFailed(run, events);
      continue;
    }

    if (hydrated.status === "planning" || !hydrated.plan || hydrated.steps.length === 0) {
      await enqueueOrchestrationPlanJob(run.id, run.companyId);
      requeued += 1;
      continue;
    }

    if (!hasRemainingOrchestrationWork(hydrated.steps)) {
      await enqueueOrchestrationConsolidateJob(run.id, run.companyId);
      requeued += 1;
      continue;
    }

    const ready = selectReadyStepsForEnqueue(hydrated.steps);
    const runningSteps = hydrated.steps.filter((step) => step.status === "running");
    const targets = ready.length ? ready : runningSteps;
    if (!targets.length) {
      skipped.push(run.id);
      continue;
    }

    for (const step of targets) {
      await enqueueOrchestrationStepJob(run.id, run.companyId, step.id);
      requeued += 1;
    }
  }

  return { requeued, skipped };
}

function readStaleOrchestrationRunMs(): number {
  const raw = process.env.ORC_STALE_RUN_MS;
  if (!raw) return DEFAULT_STALE_ORCHESTRATION_RUN_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_STALE_ORCHESTRATION_RUN_MS;
}

function latestActivityAt(run: OrchestratorRunRecord, events: OrchestratorEvent[]): string {
  return [...events]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.createdAt
    ?? run.updatedAt
    ?? run.startedAt;
}

function isStaleOrchestrationRun(run: OrchestratorRunRecord, events: OrchestratorEvent[]): boolean {
  const staleMs = readStaleOrchestrationRunMs();
  const latest = Date.parse(latestActivityAt(run, events));
  if (!Number.isFinite(latest)) return false;
  return Date.now() - latest > staleMs;
}

async function markStaleOrchestrationRunFailed(
  run: OrchestratorRunRecord,
  events: OrchestratorEvent[],
): Promise<void> {
  const lastActivity = latestActivityAt(run, events);
  const completedAt = nowIso();
  const detail = `stale: no worker activity since ${lastActivity}`;
  const steps = await store.listOrchestratorSteps(run.id).catch(() => []);
  await Promise.all(
    steps
      .filter((step) => step.status === "running")
      .map((step) => store.upsertOrchestratorStep({
        ...step,
        status: "failed",
        output: step.output ?? detail,
        completedAt,
      }).catch(() => undefined)),
  );
  await store.updateOrchestratorRun(run.id, {
    status: "failed",
    summary: detail,
    completedAt,
  }).catch(() => undefined);
  await store.appendOrchestratorEvent({
    runId: run.id,
    companyId: run.companyId,
    kind: "run_failed",
    payload: {
      detail,
      stale: true,
      run: { id: run.id, status: "failed", summary: detail, completedAt },
    },
  }).catch(() => undefined);
  await auditTransition(run.companyId, "run_failed", run.id, detail).catch(() => undefined);
}

function parseOrchestrationJobPayload(job: {
  id: string;
  companyId?: string;
  metadata: Record<string, unknown>;
}): OrchestrationStepPayload | undefined {
  const action = job.metadata.action;
  const runId = job.metadata.runId;
  if (typeof action !== "string" || typeof runId !== "string" || !job.companyId) return undefined;
  if (action !== "plan" && action !== "execute_step" && action !== "consolidate") return undefined;
  return {
    jobRunId: job.id,
    companyId: job.companyId,
    runId,
    action,
    stepId: typeof job.metadata.stepId === "string" ? job.metadata.stepId : undefined,
    timeoutMs: readWorkerTimeout(job.metadata.timeoutMs),
  };
}

function readWorkerTimeout(value: unknown): number | undefined {
  return typeof value === "number" && value > 0 ? value : undefined;
}

async function listOrchestratorRunsForReconcile(
  companyId: string | undefined,
  jobs: Array<{ metadata: Record<string, unknown> }>,
) {
  if (companyId) return store.listOrchestratorRuns(companyId);
  const runIds = new Set<string>();
  for (const job of jobs) {
    if (typeof job.metadata.runId === "string") runIds.add(job.metadata.runId);
  }
  const runs = await Promise.all([...runIds].map((runId) => store.getOrchestratorRun(runId).catch(() => undefined)));
  return runs.filter((run): run is NonNullable<typeof run> => Boolean(run));
}
