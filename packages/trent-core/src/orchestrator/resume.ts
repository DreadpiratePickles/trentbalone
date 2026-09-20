/**
 * `orchestrator.resume(runId)` (design D2; harness audit 2026-09-19 section 4 item 6).
 *
 * The app persists every step and its job rows, and its own worker re-enqueues a run from them
 * (`apps/web/lib/orchestrator-run-worker.ts` requeueRunningOrchestrationJobs), but the wrapper's
 * drain loop only ever drained the run it launched. This module is the missing half for the
 * CLI: it rebuilds the run through the app's `hydrateOrchestrationRun` (which also refreshes the
 * live cache the phases read), decides what the dead process owed, and enqueues exactly that:
 *
 *   - a job row still `running` for this run: nothing to enqueue, the drain loop takes it;
 *   - no plan yet: the plan job;
 *   - no step left `pending`, `running` or `awaiting_approval`: the consolidate job;
 *   - otherwise the steps `selectReadyStepsForEnqueue` names, or, when none is ready, the steps
 *     the dead process left `running` (the app's own rule);
 *   - a terminal run: nothing at all; the caller reports the snapshot as it is.
 *
 * Why a replayed step cannot repeat a side effect: its tool calls are keyed by `{runId, stepId,
 * tool, args}` in the durable idempotency store (`governance/idempotent-dispatch.ts`), and the
 * vocabulary covers write, send, post, book, invoice and charge (G3), so the second execution of
 * the same call in the same step is answered from the store. `resume.test.ts` proves it.
 */
import { EXIT, TrentError } from "../errors/index.js";
import type { HydratedRun, LaunchedRun, Libs } from "./libs.js";

export const RESUME_OPERATION = "orchestrator.resume";

/** Statuses the app's own re-enqueue leaves alone; a resumed handle just reports them. */
export const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);

/** What was enqueued for the drain loop, for the caller's diagnostics and the tests. */
export type ResumePlan =
  | { readonly kind: "finished"; readonly status: string }
  | { readonly kind: "in_flight"; readonly jobs: number }
  | { readonly kind: "awaiting_approval"; readonly stepIds: readonly string[] }
  | { readonly kind: "plan" }
  | { readonly kind: "consolidate" }
  | { readonly kind: "steps"; readonly stepIds: readonly string[]; readonly replayed: readonly string[] };

export interface PreparedResume {
  readonly run: HydratedRun;
  readonly plan: ResumePlan;
  /** The `LaunchedRun` shape the orchestrator's stream synthesises `run_start` from. */
  readonly launched: LaunchedRun;
}

function notFound(runId: string): TrentError {
  return new TrentError({
    code: EXIT.CONFIG,
    operation: RESUME_OPERATION,
    message: `no orchestration run with id ${runId} exists in this store; trent jobs failed lists the runs this profile knows`,
    target: runId,
  });
}

/** How many `orchestration_step` job rows are still `running` for this run: the dead process's queue. */
async function inFlightJobs(libs: Libs, run: HydratedRun): Promise<number> {
  const rows = await libs.store.listJobRuns(run.companyId);
  return rows.filter((job) => job.type === "orchestration_step" && job.status === "running" && job.metadata?.runId === run.id).length;
}

/** The run as its rows describe it, cached live for the phases. Throws for an unknown id. */
export async function hydrateOrThrow(libs: Libs, runId: string): Promise<HydratedRun> {
  const run = await libs.runPersist.hydrateOrchestrationRun(runId);
  if (run === undefined) throw notFound(runId);
  return run;
}

/** Rebuilds the run and enqueues what it owes. Throws for an unknown id; never re-plans a planned run. */
export async function prepareResume(libs: Libs, runId: string): Promise<PreparedResume> {
  const run = await hydrateOrThrow(libs, runId);
  const launched: LaunchedRun = { id: run.id, objective: run.objective, status: run.status, trigger: run.trigger, startedAt: run.startedAt };
  const done = (plan: ResumePlan): PreparedResume => ({ run, plan, launched });

  if (TERMINAL_RUN_STATUSES.has(run.status)) return done({ kind: "finished", status: run.status });

  const waiting = run.steps.filter((step) => step.status === "awaiting_approval").map((step) => step.id);
  if (run.status === "awaiting_approval" || waiting.length > 0) return done({ kind: "awaiting_approval", stepIds: waiting });

  const jobs = await inFlightJobs(libs, run);
  if (jobs > 0) return done({ kind: "in_flight", jobs });

  if (run.status === "planning" || run.plan === undefined || run.steps.length === 0) {
    await libs.runQueue.enqueueOrchestrationPlanJob(run.id, run.companyId);
    return done({ kind: "plan" });
  }
  if (!libs.runQueue.hasRemainingOrchestrationWork(run.steps)) {
    await libs.runQueue.enqueueOrchestrationConsolidateJob(run.id, run.companyId);
    return done({ kind: "consolidate" });
  }
  const ready = libs.orchestrator.selectReadyStepsForEnqueue(run.steps).map((step) => step.id);
  const replayed = ready.length > 0 ? [] : run.steps.filter((step) => step.status === "running").map((step) => step.id);
  const targets = ready.length > 0 ? ready : replayed;
  if (targets.length === 0) {
    throw new TrentError({
      code: EXIT.RUN_FAILED,
      operation: RESUME_OPERATION,
      message: `run ${runId} has work left but no step is ready or running (${run.steps.map((s) => `${s.id}:${s.status}`).join(", ")}); it cannot be resumed as it stands`,
      target: runId,
    });
  }
  for (const stepId of targets) await libs.runQueue.enqueueOrchestrationStepJob(run.id, run.companyId, stepId);
  return done({ kind: "steps", stepIds: targets, replayed });
}

/** One line for a `heartbeat` event so the reader knows what a resume decided. */
export function describeResume(plan: ResumePlan): string {
  switch (plan.kind) {
    case "finished": return `resume: the run is already ${plan.status}; nothing to do`;
    case "in_flight": return `resume: ${plan.jobs} queued job${plan.jobs === 1 ? "" : "s"} left by the previous process; draining them`;
    case "awaiting_approval": return `resume: waiting on approval for ${plan.stepIds.join(", ") || "the run"}`;
    case "plan": return "resume: no plan was recorded; planning again";
    case "consolidate": return "resume: every step is settled; consolidating";
    case "steps": return plan.replayed.length > 0
      ? `resume: replaying ${plan.replayed.join(", ")} (left running by the previous process; recorded side effects are not repeated)`
      : `resume: enqueued ${plan.stepIds.join(", ")}`;
  }
}
