/**
 * Verify Redis connectivity, BullMQ queue reachability, and worker heartbeat.
 *
 * Usage: npm run worker:health
 * Requires REDIS_URL in .env.local (Next.js loads it via loadEnvFile when present).
 */
import { getRedisConnection, QUEUE_NAME } from "../lib/queue";
import {
  isWorkerAlive,
  readWorkerHeartbeat,
  WORKER_HEARTBEAT_KEY,
} from "../lib/worker-heartbeat";

function loadEnvFiles() {
  for (const file of [".env.local", ".env"]) {
    try {
      process.loadEnvFile(file);
    } catch {
      // missing file
    }
  }
}

async function main() {
  loadEnvFiles();

  const url = process.env.REDIS_URL?.trim();
  if (!url) {
    console.error("REDIS_URL is not set. Add it to .env.local and retry.");
    process.exit(1);
  }

  const connection = getRedisConnection();
  if (!connection) {
    console.error("REDIS_URL is invalid:", url);
    process.exit(1);
  }

  const Redis = (await import("ioredis")).default;
  const redis = new Redis(url, { maxRetriesPerRequest: 1 });

  try {
    const pong = await redis.ping();
    console.log(`Redis PING: ${pong}`);

    const seenAt = await readWorkerHeartbeat();
    if (seenAt) {
      console.log(`Worker heartbeat (${WORKER_HEARTBEAT_KEY}): ${seenAt}`);
      console.log(`Worker alive: ${isWorkerAlive(seenAt) ? "yes" : "stale — restart npm run worker"}`);
    } else {
      console.log(`Worker heartbeat: not found — start the worker in another terminal: npm run worker`);
    }

    const { Queue } = await import("bullmq");
    const queue = new Queue(QUEUE_NAME, { connection });
    const counts = await queue.getJobCounts(
      "waiting",
      "active",
      "completed",
      "failed",
      "delayed",
      "paused",
    );
    console.log(`Queue "${QUEUE_NAME}" job counts:`, counts);
    await queue.close();
  } finally {
    redis.disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
