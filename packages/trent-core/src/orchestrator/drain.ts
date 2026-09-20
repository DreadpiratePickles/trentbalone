/**
 * The drain loop `createOrchestrator` runs for every handle, `run` or `resume`, moved out of
 * `index.ts` unchanged when `resume` landed. Ported from `orchestration-eval-integration.ts:126-144`
 * and extended with the three exits a long-lived CLI needs, plus the approval wait.
 */
import { runWithToolCallContext } from "../governance/tool-call-context.js";
import type { Libs } from "./libs.js";

export type DrainExit = "drained" | "interrupted" | "bounded";

export interface DrainControl {
  isInterrupted(): boolean;
  /** Resolves when approve()/reject()/cancel() or an abort wakes a parked run. */
  waitForResume(): Promise<void>;
  /** Resolves once every event received so far has been shaped, so verdicts made there are visible. */
  settle(): Promise<void>;
}

/**
 * Executes queued orchestration jobs until the run is finished, the bound is reached, or the caller
 * interrupts. Ported from `orchestration-eval-integration.ts:126-144` and extended with the three
 * exits a long-lived CLI needs, plus the approval wait: when the queue is empty because the run is
 * parked on a human decision, the loop waits for `approve()`/`reject()` rather than returning.
 *
 * @returns why the loop stopped, for the caller's diagnostics.
 */
export async function drainRun(libs: Libs, companyId: string, runId: string, maxJobs: number, control: DrainControl): Promise<DrainExit> {
  for (let i = 0; i < maxJobs; i += 1) {
    await control.settle();
    if (control.isInterrupted()) return "interrupted";

    const next = (await libs.store.listJobRuns(companyId))
      .filter((job) => job.type === "orchestration_step" && job.status === "running")
      .filter((job) => job.metadata?.runId === runId)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0];
    if (!next) {
      const live = libs.orchestrator.getOrchestrationRun(runId);
      if (live?.status !== "awaiting_approval") return "drained";
      await control.waitForResume();
      continue;
    }

    try {
      const stepId = next.metadata?.stepId;
      const job = (): Promise<unknown> =>
        libs.queue.processJobData("orchestration_step", { jobRunId: next.id, companyId, runId, action: next.metadata?.action, stepId });
      // The step's tool calls read this context to key their idempotency rows (governance/idempotent-dispatch.ts).
      await (stepId === undefined ? job() : runWithToolCallContext({ runId, stepId }, job));
    } catch (error) {
      // A cancelled run makes the in-flight worker throw; that is the interruption, not a fault.
      if (control.isInterrupted()) return "interrupted";
      throw error;
    }
  }
  return "bounded";
}

/** The same shape `apps/web/lib/store` derives from a company name, so the lookup round-trips. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "")
    .slice(0, 48);
}
