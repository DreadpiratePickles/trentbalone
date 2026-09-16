import { Worker } from "bullmq";
import { getRedisConnection, QUEUE_NAME, processJobData, requeueRunningOrchestrationJobs } from "./queue";
import { writeWorkerHeartbeat } from "./worker-heartbeat";
import { runSandboxReaperSweep, sandboxReaperEnabled } from "./workbench-sandbox-reaper";
import { runAutonomousSweep, autonomySweepEnabled, parseCompanyAllowlist } from "./autonomy-scheduler";

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
      job.name !== "content_performance_ingest" &&
      job.name !== "webhook_delivery"
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

// Autonomy scheduler — the proactive "runs while you sleep" loop. OFF unless
// AUTONOMY_SWEEP_ENABLED=1; only acts on companies in `autonomous` mode (and an
// optional AUTONOMY_SWEEP_COMPANY_IDS allowlist). Runs in the worker so exactly
// one process owns the sweep; each launched cycle keeps all spend/approval rails.
const AUTONOMY_SWEEP_INTERVAL_MS = Number(process.env.AUTONOMY_SWEEP_INTERVAL_MS ?? 3 * 60 * 60 * 1000);
const autonomyAllowlist = parseCompanyAllowlist();
const autonomySweepTimer = autonomySweepEnabled()
  ? setInterval(() => {
      void runAutonomousSweep({ allowlist: autonomyAllowlist })
        .then((s) => console.log(`[Worker] Autonomy sweep: ${s.eligible} eligible, ${s.acted} acted, ${s.monitored} monitored, ${s.skipped} skipped`))
        .catch((err) => console.error("[Worker] Autonomy sweep failed:", err));
    }, AUTONOMY_SWEEP_INTERVAL_MS)
  : undefined;
if (autonomySweepTimer) {
  const scope = autonomyAllowlist.length ? `companies [${autonomyAllowlist.join(", ")}]` : "all autonomous-mode companies";
  console.log(`[Worker] Autonomy scheduler armed (every ${Math.round(AUTONOMY_SWEEP_INTERVAL_MS / 1000)}s) for ${scope}`);
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
  if (autonomySweepTimer) clearInterval(autonomySweepTimer);
  await worker.close();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
