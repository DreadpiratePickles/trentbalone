import { Worker } from "bullmq";
import { getRedisConnection, QUEUE_NAME, processJobData, requeueRunningOrchestrationJobs } from "./queue";
import { writeWorkerHeartbeat } from "./worker-heartbeat";

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

worker.on("completed", (job) => {
  console.log(`[Worker] Job ${job.id} (${job.name}) completed`);
});

worker.on("failed", (job, err) => {
  console.error(`[Worker] Job ${job?.id} (${job?.name}) failed:`, err);
});

async function shutdown(signal: string) {
  console.log(`[Worker] ${signal} received, shutting down gracefully...`);
  clearInterval(heartbeatTimer);
  await worker.close();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
