import { Worker } from "bullmq";
import { getRedisConnection, QUEUE_NAME, processJobData, requeueRunningOrchestrationJobs } from "./queue";
import { writeWorkerHeartbeat } from "./worker-heartbeat";
import { runSandboxReaperSweep, sandboxReaperEnabled } from "./workbench-sandbox-reaper";

const connection = getRedisConnection();
if (!connection) {
  console.error("Error: REDIS_URL is not set. Worker cannot start.");
  process.exit(1);
}

console.log(`Starting BullMQ worker on queue "${QUEUE_NAME}"...`);

const HEARTBEAT_INTERVAL_MS = 10_000;

async function pingHeartbeat() {
  const ok = await writeWorkerHeartbeat();
  if (!ok) {
    console.warn("[Worker] Failed to write Redis heartbeat");
  }
}

const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    console.log(`[Worker] Received job ${job.id} (type: ${job.name})`);
    if (
      job.name !== "scheduled_cycle_sweep" &&
      job.name !== "company_scheduled_cycle" &&
      job.name !== "recurring_task_materialization" &&
      job.name !== "workbench_session_sweep" &&
      job.name !== "run_subtask" &&
      job.name !== "orchestration_step" &&
      job.name !== "wiki_index_refresh" &&
      job.name !== "platform_action" &&
      job.name !== "content_performance_ingest"
    ) {
      throw new Error(`Unknown job type: ${job.name}`);
    }
    await processJobData(job.name, job.data);
    await pingHeartbeat();
  },
  { connection }
);

worker.on("ready", () => {
  console.log(`[Worker] Connected to Redis; consuming queue "${QUEUE_NAME}"`);
  void pingHeartbeat();
  void requeueRunningOrchestrationJobs().then((result) => {
    if (result.requeued > 0) {
      console.log(`[Worker] Re-enqueued ${result.requeued} orchestration job(s) after boot`);
    }
  }).catch((err) => {
    console.error("[Worker] Failed to reconcile orchestration runs:", err);
  });
});

const heartbeatTimer = setInterval(() => {
  void pingHeartbeat();
}, HEARTBEAT_INTERVAL_MS);

// Periodic E2B idle-sandbox reaper (cost control). No-op unless E2B is the
// provider; runs in the worker so exactly one process owns the sweep.
const SANDBOX_REAPER_INTERVAL_MS = Number(process.env.E2B_SANDBOX_REAPER_INTERVAL_MS ?? 5 * 60 * 1000);
const sandboxReaperTimer = sandboxReaperEnabled()
  ? setInterval(() => {
      void runSandboxReaperSweep().catch((err) => console.error("[Worker] Sandbox reaper sweep failed:", err));
    }, SANDBOX_REAPER_INTERVAL_MS)
  : undefined;
if (sandboxReaperTimer) {
  console.log(`[Worker] E2B idle-sandbox reaper armed (every ${Math.round(SANDBOX_REAPER_INTERVAL_MS / 1000)}s)`);
}

worker.on("completed", (job) => {
  console.log(`[Worker] Job ${job.id} (${job.name}) completed`);
});

worker.on("failed", (job, err) => {
  console.error(`[Worker] Job ${job?.id} (${job?.name}) failed:`, err);
});

async function shutdown(signal: string) {
  console.log(`[Worker] ${signal} received, shutting down gracefully...`);
  clearInterval(heartbeatTimer);
  if (sandboxReaperTimer) clearInterval(sandboxReaperTimer);
  await worker.close();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
