import type { Queue as BullQueue } from "bullmq";
import { emitJobEvent } from "@/lib/job-events";
import { store } from "@/lib/store";
import { nowIso } from "@/lib/utils";
import { workbenchSessionSweep } from "@/lib/workbench-orchestrator";
import type { JobRun } from "@/lib/types";
import { subtaskSchema, type Subtask, type SeatResult } from "@/lib/planner";
import { runWikiIndexRefresh } from "@/lib/trench-wiki-indexer";

export const QUEUE_NAME = "trent-autonomy-queue";
const DEFAULT_JOB_TIMEOUT_MS = 1000 * 60 * 10;

export type QueueJobName = "scheduled_cycle_sweep" | "company_scheduled_cycle" | "recurring_task_materialization" | "workbench_session_sweep" | "run_subtask" | "orchestration_step" | "wiki_index_refresh" | "platform_action" | "content_performance_ingest";

type ScheduledCycleSweepPayload = {
  jobRunId: string;
  trigger: JobRun["trigger"];
  companyIds?: string[];
  timeoutMs?: number;
  delayMs?: number;
};

type CompanyCyclePayload = {
  jobRunId: string;
  companyId: string;
  trigger: JobRun["trigger"];
  cycleTrigger: "manual" | "scheduled";
  timeoutMs?: number;
  delayMs?: number;
};

type RecurringTaskMaterializationPayload = {
  jobRunId: string;
  companyId: string;
  trigger: "user" | "system";
  timeoutMs?: number;
  delayMs?: number;
};

type WorkbenchSessionSweepPayload = {
  jobRunId: string;
  trigger: "cron" | "user";
  timeoutMs?: number;
  delayMs?: number;
};

type RunSubtaskPayload = {
  jobRunId: string;
  companyId: string;
  subtask: Subtask;
  timeoutMs?: number;
  delayMs?: number;
};

type WikiIndexRefreshPayload = {
  jobRunId: string;
  companyId: string;
  trigger: "user" | "system";
  sessionId?: string;
  timeoutMs?: number;
  delayMs?: number;
};

type PlatformActionPayload = {
  jobRunId: string;
  trigger: JobRun["trigger"];
  timeoutMs?: number;
  delayMs?: number;
  retryAttempt?: number;
};

type ContentPerformanceIngestPayload = {
  jobRunId: string;
  companyId: string;
  trigger: JobRun["trigger"];
  timeoutMs?: number;
  delayMs?: number;
};

type OrchestrationStepPayload = {
  jobRunId: string;
  companyId: string;
  runId: string;
  action: "plan" | "execute_step" | "consolidate";
  stepId?: string;
  timeoutMs?: number;
  delayMs?: number;
};

type QueueJobPayload =
  | ScheduledCycleSweepPayload
  | CompanyCyclePayload
  | RecurringTaskMaterializationPayload
  | WorkbenchSessionSweepPayload
  | RunSubtaskPayload
  | OrchestrationStepPayload
  | WikiIndexRefreshPayload
  | PlatformActionPayload
  | ContentPerformanceIngestPayload;

type QueueAddFunction = (type: QueueJobName, data: QueueJobPayload) => Promise<void>;
const MAX_PLATFORM_ACTION_RETRIES = 3;

function jobTimeoutMs(data: QueueJobPayload) {
  const envTimeout = Number(process.env.TRENT_JOB_TIMEOUT_MS);
  return data.timeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_JOB_TIMEOUT_MS);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, jobRunId: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Job ${jobRunId} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function updateJobRunWithEvent(id: string, patch: Partial<JobRun>) {
  const jobRun = await store.updateJobRun(id, patch);
  if (jobRun && patch.status) {
    emitJobEvent({
      jobRunId: jobRun.id,
      companyId: jobRun.companyId,
      status: patch.status,
      summary: patch.summary ?? jobRun.summary,
      at: nowIso(),
      jobRun
    });
  }
  return jobRun;
}

async function throwIfCancelled(jobRunId: string) {
  const jobRun = await store.getJobRun(jobRunId);
  if (jobRun?.status === "cancelled") {
    throw new Error(`Job ${jobRunId} was cancelled before execution`);
  }
}

export function getRedisConnection() {
  const url = process.env.REDIS_URL;
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname,
      port: parseInt(parsed.port || "6379", 10),
      username: parsed.username || undefined,
      password: parsed.password || undefined,
      tls: parsed.protocol === "rediss:" ? {} : undefined,
    };
  } catch (e) {
    console.error("Invalid REDIS_URL configuration:", url);
    return undefined;
  }
}

// Queue singleton
declare global {
  // eslint-disable-next-line no-var
  var __trentQueue: BullQueue | undefined;
}

export const getQueue = async () => {
  const connection = getRedisConnection();
  if (!connection) return null;
  if (!globalThis.__trentQueue) {
    const { Queue } = await import("bullmq");
    globalThis.__trentQueue = new Queue(QUEUE_NAME, { connection });
  }
  return globalThis.__trentQueue;
};

function shouldRunFallbackProcessor() {
  return process.env.NODE_ENV !== "test" && process.env.TRENT_QUEUE_FALLBACK !== "disabled";
}

function runFallbackJob(type: QueueJobName, data: QueueJobPayload) {
  if (!shouldRunFallbackProcessor()) return;
  if (process.env.TRENT_EVAL_SYNC_QUEUE === "1") {
    void processJobData(type, data).catch((err: unknown) => {
      console.error(`[Queue Fallback] Error running ${type}:`, err);
    });
    return;
  }
  console.log(`[Queue Fallback] Enqueuing ${type} inline/async`);
  setTimeout(() => {
    processJobData(type, data).catch((err: unknown) => {
      console.error(`[Queue Fallback] Error running ${type}:`, err);
    });
  }, data.delayMs ?? 0);
}

export async function processJobData(type: QueueJobName, data: QueueJobPayload) {
  const { jobRunId } = data;
  if (!jobRunId) throw new Error("Missing jobRunId in job data");

  console.log(`[Worker] Starting job ${jobRunId} of type ${type}`);
  await throwIfCancelled(jobRunId);
  const existing = await store.getJobRun(jobRunId);
  emitJobEvent({
    jobRunId,
    companyId: existing?.companyId,
    status: "started",
    summary: existing?.summary ?? `Started ${type}.`,
    at: nowIso(),
    jobRun: existing
  });

  if (type === "scheduled_cycle_sweep") {
    const { companyIds } = data as ScheduledCycleSweepPayload;
    try {
      const { runDueScheduledCycles } = await import("@/lib/scheduler");
      const results = await withTimeout(
        runDueScheduledCycles(undefined, companyIds),
        jobTimeoutMs(data),
        jobRunId
      );
      if ((await store.getJobRun(jobRunId))?.status === "cancelled") return;
      await updateJobRunWithEvent(jobRunId, {
        status: "completed",
        completedAt: nowIso(),
        resultCount: results.length,
        summary: `Completed scheduled cycle sweep with ${results.length} cycle${results.length === 1 ? "" : "s"} run.`
      });
      console.log(`[Worker] Job ${jobRunId} completed successfully`);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : "Unknown scheduler error";
      const wasCancelled = (await store.getJobRun(jobRunId))?.status === "cancelled";
      if (wasCancelled) return;
      await updateJobRunWithEvent(jobRunId, {
        status: "failed",
        completedAt: nowIso(),
        error: errMsg,
        summary: "Scheduled cycle sweep failed."
      });
      console.error(`[Worker] Job ${jobRunId} failed: ${errMsg}`);
      throw error;
    }
    return;
  }

  if (type === "company_scheduled_cycle") {
    const { companyId, cycleTrigger } = data as CompanyCyclePayload;
    try {
      const { launchOrchestration } = await import("@/lib/orchestrator") as typeof import("@/lib/orchestrator");
      const run = await withTimeout(
        launchOrchestration({
          companyId,
          objective: buildOperatingCycleObjective(cycleTrigger),
          trigger: cycleTrigger,
          fullTeam: true,
          cycleKind: "scheduled",
        }),
        jobTimeoutMs(data),
        jobRunId
      );
      if ((await store.getJobRun(jobRunId))?.status === "cancelled") return;
      const current = await store.getJobRun(jobRunId);
      await updateJobRunWithEvent(jobRunId, {
        status: "completed",
        completedAt: nowIso(),
        resultCount: 1,
        summary: `Launched durable operating cycle ${run.cycleId ?? run.id}.`,
        metadata: {
          ...(current?.metadata ?? {}),
          result: {
            run: {
              id: run.id,
              cycleId: run.cycleId,
              status: run.status,
              objective: run.objective,
            },
          },
          launchedOrchestrationAt: nowIso(),
        },
      });
      console.log(`[Worker] Job ${jobRunId} completed successfully`);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : "Unknown company cycle error";
      const wasCancelled = (await store.getJobRun(jobRunId))?.status === "cancelled";
      if (wasCancelled) return;
      const current = await store.getJobRun(jobRunId);
      await updateJobRunWithEvent(jobRunId, {
        status: "failed",
        completedAt: nowIso(),
        error: errMsg,
        summary: "Company cycle failed.",
        metadata: {
          ...(current?.metadata ?? {}),
          failedCycleAt: nowIso(),
          error: errMsg,
        },
      });
      console.error(`[Worker] Job ${jobRunId} failed: ${errMsg}`);
      throw error;
    }
    return;
  }

  if (type === "recurring_task_materialization") {
    const { companyId } = data as RecurringTaskMaterializationPayload;
    try {
      const { materializeDueRecurringTasks } = await import("@/lib/scheduler");
      const tasks = await withTimeout(
        materializeDueRecurringTasks(companyId),
        jobTimeoutMs(data),
        jobRunId
      );
      if ((await store.getJobRun(jobRunId))?.status === "cancelled") return;
      await updateJobRunWithEvent(jobRunId, {
        status: "completed",
        completedAt: nowIso(),
        resultCount: tasks.length,
        summary: `Materialized ${tasks.length} recurring task${tasks.length === 1 ? "" : "s"}.`
      });
      console.log(`[Worker] Job ${jobRunId} completed successfully`);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : "Unknown recurring task error";
      const wasCancelled = (await store.getJobRun(jobRunId))?.status === "cancelled";
      if (wasCancelled) return;
      await updateJobRunWithEvent(jobRunId, {
        status: "failed",
        completedAt: nowIso(),
        error: errMsg,
        summary: "Recurring task materialization failed."
      });
      console.error(`[Worker] Job ${jobRunId} failed: ${errMsg}`);
      throw error;
    }
    return;
  }

  if (type === "workbench_session_sweep") {
    try {
      const result = await withTimeout(
        workbenchSessionSweep(),
        jobTimeoutMs(data),
        jobRunId
      );
      if ((await store.getJobRun(jobRunId))?.status === "cancelled") return;
      await updateJobRunWithEvent(jobRunId, {
        status: "completed",
        completedAt: nowIso(),
        resultCount: result.terminated,
        summary: `Workbench session sweep terminated ${result.terminated} session${result.terminated === 1 ? "" : "s"}.`
      });
      console.log(`[Worker] Job ${jobRunId} completed successfully`);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : "Unknown sweep error";
      const wasCancelled = (await store.getJobRun(jobRunId))?.status === "cancelled";
      if (wasCancelled) return;
      await updateJobRunWithEvent(jobRunId, {
        status: "failed",
        completedAt: nowIso(),
        error: errMsg,
        summary: "Workbench session sweep failed."
      });
      console.error(`[Worker] Job ${jobRunId} failed: ${errMsg}`);
      throw error;
    }
    return;
  }

  if (type === "orchestration_step") {
    const payload = data as OrchestrationStepPayload;
    try {
      const { processOrchestrationStepJob } = await import("@/lib/orchestrator-run-worker") as typeof import("@/lib/orchestrator-run-worker");
      await withTimeout(processOrchestrationStepJob(payload), jobTimeoutMs(data), jobRunId);
      if ((await store.getJobRun(jobRunId))?.status === "cancelled") return;
      const current = await store.getJobRun(jobRunId);
      await updateJobRunWithEvent(jobRunId, {
        status: "completed",
        completedAt: nowIso(),
        resultCount: 1,
        summary: `Completed orchestration ${payload.action}${payload.stepId ? `:${payload.stepId}` : ""}.`,
        metadata: {
          ...(current?.metadata ?? {}),
          completedOrchestrationAt: nowIso(),
        },
      });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : "Unknown orchestration step error";
      const wasCancelled = (await store.getJobRun(jobRunId))?.status === "cancelled";
      if (wasCancelled) return;
      const current = await store.getJobRun(jobRunId);
      await updateJobRunWithEvent(jobRunId, {
        status: "failed",
        completedAt: nowIso(),
        error: errMsg,
        summary: "Orchestration step failed.",
        metadata: {
          ...(current?.metadata ?? {}),
          failedOrchestrationAt: nowIso(),
          error: errMsg,
        },
      });
      throw error;
    }
    return;
  }

  if (type === "run_subtask") {
    const { companyId, subtask } = data as RunSubtaskPayload;
    try {
      const { processSubtaskJob } = await import("@/lib/seat-worker") as typeof import("@/lib/seat-worker");
      const result = await withTimeout(processSubtaskJob({ companyId, subtask }), jobTimeoutMs(data), jobRunId);
      if ((await store.getJobRun(jobRunId))?.status === "cancelled") return;
      const current = await store.getJobRun(jobRunId);
      await updateJobRunWithEvent(jobRunId, {
        status: "completed",
        completedAt: nowIso(),
        resultCount: 1,
        summary: `Completed ${subtask.seat} subtask with confidence ${result.confidence}.`,
        metadata: {
          ...(current?.metadata ?? {}),
          result: persistSeatResult(result),
          completedSubtaskAt: nowIso(),
        },
      });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : "Unknown subtask error";
      const wasCancelled = (await store.getJobRun(jobRunId))?.status === "cancelled";
      if (wasCancelled) return;
      const current = await store.getJobRun(jobRunId);
      await updateJobRunWithEvent(jobRunId, {
        status: "failed",
        completedAt: nowIso(),
        error: errMsg,
        summary: "Subtask worker failed.",
        metadata: {
          ...(current?.metadata ?? {}),
          failedSubtaskAt: nowIso(),
          error: errMsg,
        },
      });
      throw error;
    }
    return;
  }

  if (type === "wiki_index_refresh") {
    const { companyId, sessionId } = data as WikiIndexRefreshPayload;
    try {
      const result = await withTimeout(
        runWikiIndexRefresh({ companyId, sessionId }),
        jobTimeoutMs(data),
        jobRunId
      );
      if ((await store.getJobRun(jobRunId))?.status === "cancelled") return;
      await updateJobRunWithEvent(jobRunId, {
        status: "completed",
        completedAt: nowIso(),
        resultCount: result.index.pages.length,
        summary: `Refreshed Trench Wiki index with ${result.index.pages.length} page${result.index.pages.length === 1 ? "" : "s"}.`
      });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : "Unknown wiki index error";
      const wasCancelled = (await store.getJobRun(jobRunId))?.status === "cancelled";
      if (wasCancelled) return;
      await updateJobRunWithEvent(jobRunId, {
        status: "failed",
        completedAt: nowIso(),
        error: errMsg,
        summary: "Trench Wiki index refresh failed."
      });
      throw error;
    }
    return;
  }

  if (type === "platform_action") {
    const payload = data as PlatformActionPayload;
    try {
      const { executeQueuedPlatformAction } = await import("@/lib/platform-action-runner") as typeof import("@/lib/platform-action-runner");
      const result = await withTimeout(
        executeQueuedPlatformAction(jobRunId),
        jobTimeoutMs(data),
        jobRunId
      );
      if ((await store.getJobRun(jobRunId))?.status === "cancelled") return;
      const current = await store.getJobRun(jobRunId);
      if (result.status === "failed" && shouldRetryPlatformAction(result, current)) {
        const retry = buildPlatformActionRetry(current, result);
        await updateJobRunWithEvent(jobRunId, {
          status: "running",
          completedAt: undefined,
          error: result.error,
          resultCount: 0,
          summary: `Queued platform action will retry after ${retry.retryAfterSeconds}s (${retry.reason}).`,
          metadata: {
            ...(current?.metadata ?? {}),
            retry,
            workerResult: {
              status: "retry_scheduled",
              error: result.error,
              errorCode: result.errorCode,
            },
          },
        });
        await enqueueExistingJobRunForProcessing("platform_action", {
          jobRunId,
          trigger: payload.trigger,
          timeoutMs: payload.timeoutMs,
          delayMs: retry.retryAfterSeconds * 1000,
          retryAttempt: retry.attempts,
        });
        return;
      }
      const patch: Partial<JobRun> = {
        status: result.status === "completed" ? "completed" : result.status === "failed" ? "failed" : "completed",
        completedAt: nowIso(),
        resultCount: result.status === "completed" ? 1 : 0,
        summary: result.status === "completed"
          ? "Completed queued platform action."
          : result.status === "failed"
          ? "Queued platform action failed."
          : "Skipped queued platform action.",
        metadata: {
          ...(current?.metadata ?? {}),
          workerResult: {
            status: result.status,
            externalRef: result.externalRef,
            error: result.error,
            errorCode: result.errorCode,
          },
        },
      };
      if (result.error) patch.error = result.error;
      await updateJobRunWithEvent(jobRunId, patch);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : "Unknown platform action error";
      const wasCancelled = (await store.getJobRun(jobRunId))?.status === "cancelled";
      if (wasCancelled) return;
      const current = await store.getJobRun(jobRunId);
      await updateJobRunWithEvent(jobRunId, {
        status: "failed",
        completedAt: nowIso(),
        error: errMsg,
        summary: "Queued platform action failed.",
        metadata: {
          ...(current?.metadata ?? {}),
          workerResult: { status: "failed", error: errMsg },
        },
      });
      throw error;
    }
    return;
  }

  if (type === "content_performance_ingest") {
    try {
      const { executeContentPerformanceFeedbackJob } = await import("@/lib/content/performance-feedback") as typeof import("@/lib/content/performance-feedback");
      const result = await withTimeout(
        executeContentPerformanceFeedbackJob(jobRunId),
        jobTimeoutMs(data),
        jobRunId
      );
      if ((await store.getJobRun(jobRunId))?.status === "cancelled") return;
      const current = await store.getJobRun(jobRunId);
      const patch: Partial<JobRun> = {
        status: result.status === "failed" ? "failed" : "completed",
        completedAt: nowIso(),
        resultCount: result.status === "completed" ? 1 : 0,
        summary: result.status === "completed"
          ? "Completed content and ad performance feedback ingestion."
          : result.status === "failed"
          ? "Content and ad performance feedback ingestion failed."
          : "Skipped content and ad performance feedback ingestion.",
        metadata: {
          ...(current?.metadata ?? {}),
          workerResult: result.result ?? { status: result.status, error: result.error },
        },
      };
      if (result.error) patch.error = result.error;
      await updateJobRunWithEvent(jobRunId, patch);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : "Unknown content performance feedback error";
      const wasCancelled = (await store.getJobRun(jobRunId))?.status === "cancelled";
      if (wasCancelled) return;
      const current = await store.getJobRun(jobRunId);
      await updateJobRunWithEvent(jobRunId, {
        status: "failed",
        completedAt: nowIso(),
        error: errMsg,
        summary: "Content and ad performance feedback ingestion failed.",
        metadata: {
          ...(current?.metadata ?? {}),
          workerResult: { status: "failed", error: errMsg },
        },
      });
      throw error;
    }
    return;
  }

  throw new Error(`Unknown job type: ${String(type)}`);
}

function buildOperatingCycleObjective(trigger: "manual" | "scheduled"): string {
  return [
    `Inspect company state for this ${trigger} operating cycle.`,
    "Identify the highest-leverage opportunities across company memory, tasks, approvals, usage, recent cycles, and connected tools.",
    "Execute safe work through the durable multi-agent orchestrator.",
    "Surface required approvals instead of taking irreversible external actions.",
    "Produce a CEO-ready summary, report, audit trail, and memory log.",
  ].join(" ");
}

async function addBullJobOrMarkFailed(type: QueueJobName, data: QueueJobPayload) {
  const q = await getQueue();
  if (!q) {
    runFallbackJob(type, data);
    return;
  }

  try {
    await q.add(type, data, {
      jobId: queueJobIdForData(type, data),
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      delay: data.delayMs,
      removeOnComplete: 100,
      removeOnFail: 100
    });
  } catch (error) {
    await updateJobRunWithEvent(data.jobRunId, {
      status: "failed",
      completedAt: nowIso(),
      error: error instanceof Error ? error.message : "Failed to enqueue BullMQ job",
      summary: `Failed to enqueue ${type}.`
    });
    throw error;
  }
}

export function queueJobIdForData(type: QueueJobName, data: QueueJobPayload): string {
  // BullMQ v5+ forbids colons in custom job IDs (conflicts with Redis key namespacing).
  // Use double-underscore as separator instead.
  if (type === "platform_action") {
    const payload = data as PlatformActionPayload;
    if (payload.delayMs && payload.delayMs > 0 && payload.retryAttempt && payload.retryAttempt > 0) {
      return `${payload.jobRunId}__retry__${payload.retryAttempt}`;
    }
  }
  if (type === "orchestration_step") {
    const payload = data as OrchestrationStepPayload;
    if (payload.action === "execute_step" && payload.stepId) {
      return `${payload.runId}__step__${payload.stepId}`;
    }
    if (payload.action === "plan") return `${payload.runId}__plan`;
    if (payload.action === "consolidate") return `${payload.runId}__consolidate`;
  }
  return data.jobRunId;
}

export async function enqueueExistingJobRunForProcessing(type: QueueJobName, data: QueueJobPayload) {
  await addBullJobOrMarkFailed(type, data);
  const job = await store.getJobRun(data.jobRunId);
  emitJobEvent({
    jobRunId: data.jobRunId,
    companyId: job?.companyId,
    status: "queued",
    summary: job?.summary ?? `Queued ${type}.`,
    at: nowIso(),
    jobRun: job,
  });
  return job;
}

export async function enqueueScheduledCycleSweep(
  trigger: "user" | "cron" | "system",
  companyIds?: string[]
) {
  const job = await store.createJobRun({
    type: "scheduled_cycle_sweep",
    status: "running",
    trigger,
    summary: "Checking companies with due scheduled cycles.",
    resultCount: 0,
    metadata: {
      at: nowIso(),
      scopedCompanyCount: companyIds?.length ?? 0
    }
  });

  await addBullJobOrMarkFailed("scheduled_cycle_sweep", {
    jobRunId: job.id,
    trigger,
    companyIds
  });
  emitJobEvent({
    jobRunId: job.id,
    status: "queued",
    summary: job.summary,
    at: nowIso(),
    jobRun: job
  });

  return job;
}

export async function enqueueCompanyCycle(input: {
  companyId: string;
  trigger: JobRun["trigger"];
  cycleTrigger: "manual" | "scheduled";
  timeoutMs?: number;
}) {
  const job = await store.createJobRun({
    type: "company_scheduled_cycle",
    status: "running",
    companyId: input.companyId,
    trigger: input.trigger,
    summary: "Queued durable company operating cycle.",
    resultCount: 0,
    metadata: {
      at: nowIso(),
      cycleTrigger: input.cycleTrigger,
      timeoutMs: input.timeoutMs ?? 0,
    },
  });

  await addBullJobOrMarkFailed("company_scheduled_cycle", {
    jobRunId: job.id,
    companyId: input.companyId,
    trigger: input.trigger,
    cycleTrigger: input.cycleTrigger,
    timeoutMs: input.timeoutMs,
  });
  emitJobEvent({
    jobRunId: job.id,
    companyId: input.companyId,
    status: "queued",
    summary: job.summary,
    at: nowIso(),
    jobRun: job,
  });

  return job;
}

export async function enqueueRecurringTaskMaterialization(
  companyId: string,
  trigger: "user" | "system"
) {
  const job = await store.createJobRun({
    type: "recurring_task_materialization",
    status: "running",
    companyId,
    trigger,
    summary: "Materializing due recurring task templates.",
    resultCount: 0,
    metadata: { at: nowIso() }
  });

  await addBullJobOrMarkFailed("recurring_task_materialization", {
    jobRunId: job.id,
    companyId,
    trigger
  });
  emitJobEvent({
    jobRunId: job.id,
    companyId,
    status: "queued",
    summary: job.summary,
    at: nowIso(),
    jobRun: job
  });

  return job;
}

export async function enqueueWorkbenchSessionSweep(
  trigger: "cron" | "user" = "cron"
) {
  const job = await store.createJobRun({
    type: "workbench_session_sweep",
    status: "running",
    trigger,
    summary: "Checking workbench sessions for timeout, budget, and idle expiry.",
    resultCount: 0,
    metadata: { at: nowIso() }
  });

  await addBullJobOrMarkFailed("workbench_session_sweep", {
    jobRunId: job.id,
    trigger
  });
  emitJobEvent({
    jobRunId: job.id,
    status: "queued",
    summary: job.summary,
    at: nowIso(),
    jobRun: job
  });

  return job;
}

export async function enqueueWikiIndexRefresh(
  companyId: string,
  trigger: "user" | "system" = "system",
  sessionId?: string
) {
  const job = await store.createJobRun({
    type: "wiki_index_refresh",
    status: "running",
    companyId,
    trigger,
    summary: "Refreshing Trench Wiki index.",
    resultCount: 0,
    metadata: {
      at: nowIso(),
      sessionId: sessionId ?? ""
    }
  });

  await addBullJobOrMarkFailed("wiki_index_refresh", {
    jobRunId: job.id,
    companyId,
    trigger,
    sessionId
  });
  emitJobEvent({
    jobRunId: job.id,
    companyId,
    status: "queued",
    summary: job.summary,
    at: nowIso(),
    jobRun: job
  });

  return job;
}

export async function enqueueSubtaskRun(input: {
  companyId: string;
  subtask: Subtask;
  trigger?: "user" | "system";
  timeoutMs?: number;
}) {
  const subtask = subtaskSchema.parse(input.subtask);
  const job = await store.createJobRun({
    type: "run_subtask",
    status: "running",
    companyId: input.companyId,
    trigger: input.trigger ?? "system",
    summary: `Running ${subtask.seat} subtask: ${subtask.objective}`,
    resultCount: 0,
    metadata: {
      at: nowIso(),
      subtask,
      subtaskId: subtask.id,
      seat: subtask.seat,
      timeoutMs: input.timeoutMs ?? 0,
    },
  });

  await addBullJobOrMarkFailed("run_subtask", {
    jobRunId: job.id,
    companyId: input.companyId,
    subtask,
    timeoutMs: input.timeoutMs,
  });
  emitJobEvent({
    jobRunId: job.id,
    companyId: input.companyId,
    status: "queued",
    summary: job.summary,
    at: nowIso(),
    jobRun: job,
  });

  return job;
}

export async function requeueRunningOrchestrationJobs(input?: {
  companyId?: string;
  addJob?: QueueAddFunction;
}) {
  const { requeueRunningOrchestrationJobs: requeue } = await import("@/lib/orchestrator-run-worker") as typeof import("@/lib/orchestrator-run-worker");
  return requeue(input);
}

export async function requeueRunningSubtaskJobs(input?: {
  companyId?: string;
  addJob?: QueueAddFunction;
}) {
  const runs = await store.listJobRuns(input?.companyId);
  let requeued = 0;
  const skipped: string[] = [];

  for (const job of runs) {
    if (job.type !== "run_subtask" || job.status !== "running" || !job.companyId) continue;
    const subtask = parsePersistedSubtask(job.metadata.subtask);
    if (!subtask) {
      skipped.push(job.id);
      continue;
    }
    const data: RunSubtaskPayload = {
      jobRunId: job.id,
      companyId: job.companyId,
      subtask,
      timeoutMs: readTimeoutMs(job.metadata.timeoutMs),
    };
    if (input?.addJob) {
      await input.addJob("run_subtask", data);
    } else {
      await addBullJobOrMarkFailed("run_subtask", data);
    }
    await store.updateJobRun(job.id, {
      metadata: {
        ...job.metadata,
        requeuedAt: nowIso(),
      },
    });
    requeued += 1;
  }

  return { requeued, skipped };
}

export async function cancelJobRun(jobRunId: string) {
  const jobRun = await store.getJobRun(jobRunId);
  if (!jobRun) return undefined;
  if (jobRun.status !== "running") return jobRun;

  const q = await getQueue();
  if (q) {
    const queuedJob = await q.getJob(jobRunId);
    if (queuedJob) {
      try {
        await queuedJob.remove();
      } catch {
        // Active jobs cannot always be removed; the cooperative status check handles the rest.
      }
    }
  }

  return updateJobRunWithEvent(jobRunId, {
    status: "cancelled",
    completedAt: nowIso(),
    summary: "Job was cancelled before completion."
  });
}

export async function removeQueuedBullJob(jobRunId: string) {
  const q = await getQueue();
  if (!q) return { hasQueue: false as const, removed: false as const };

  const queuedJob = await q.getJob(jobRunId);
  if (!queuedJob) {
    return { hasQueue: true as const, removed: false as const, state: "missing" };
  }

  const state = await queuedJob.getState();
  if (state === "active") {
    return { hasQueue: true as const, removed: false as const, state };
  }

  try {
    await queuedJob.remove();
    return { hasQueue: true as const, removed: true as const, state };
  } catch {
    return { hasQueue: true as const, removed: false as const, state };
  }
}

function parsePersistedSubtask(value: unknown): Subtask | undefined {
  const parsed = subtaskSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function readTimeoutMs(value: unknown): number | undefined {
  return typeof value === "number" && value > 0 ? value : undefined;
}

function persistSeatResult(result: SeatResult) {
  return {
    seat: result.seat,
    payloadRef: result.payloadRef,
    confidence: result.confidence,
    costCents: result.costCents,
    workRequests: result.workRequests,
    error: result.error,
  };
}

function shouldRetryPlatformAction(
  result: { status: string; errorCode?: string },
  jobRun: JobRun | undefined,
) {
  if (result.status !== "failed") return false;
  if (!["rate_limited", "provider_error"].includes(result.errorCode ?? "")) return false;
  return readRetryAttempts(jobRun?.metadata.retry) < MAX_PLATFORM_ACTION_RETRIES;
}

function buildPlatformActionRetry(
  jobRun: JobRun | undefined,
  result: { errorCode?: string; retryAfterSeconds?: number },
) {
  const attempts = readRetryAttempts(jobRun?.metadata.retry) + 1;
  const retryAfterSeconds = retryAfter(result.retryAfterSeconds, attempts);
  return {
    attempts,
    maxAttempts: MAX_PLATFORM_ACTION_RETRIES,
    reason: result.errorCode ?? "provider_error",
    retryAfterSeconds,
    nextRetryAt: new Date(Date.now() + retryAfterSeconds * 1000).toISOString(),
  };
}

function readRetryAttempts(value: unknown) {
  if (!value || typeof value !== "object") return 0;
  const attempts = (value as { attempts?: unknown }).attempts;
  return typeof attempts === "number" && Number.isFinite(attempts) && attempts > 0 ? attempts : 0;
}

function retryAfter(providerRetryAfterSeconds: number | undefined, attempts: number) {
  if (typeof providerRetryAfterSeconds === "number" && Number.isFinite(providerRetryAfterSeconds) && providerRetryAfterSeconds > 0) {
    return Math.min(Math.ceil(providerRetryAfterSeconds), 60 * 60);
  }
  return Math.min(30 * 2 ** Math.max(0, attempts - 1), 60 * 15);
}
