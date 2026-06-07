import Redis from "ioredis";

export const WORKER_HEARTBEAT_KEY = "trent:worker:heartbeat";
export const WORKER_HEARTBEAT_TTL_SEC = 30;

function redisUrl(): string | undefined {
  return process.env.REDIS_URL?.trim() || undefined;
}

/** True when the worker wrote a heartbeat within the TTL window. */
export function isWorkerAlive(seenAt: string | null, nowMs = Date.now()): boolean {
  if (!seenAt) return false;
  const ageMs = nowMs - new Date(seenAt).getTime();
  return ageMs >= 0 && ageMs < WORKER_HEARTBEAT_TTL_SEC * 1000;
}

export async function writeWorkerHeartbeat(): Promise<boolean> {
  const url = redisUrl();
  if (!url) return false;

  const redis = new Redis(url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });

  try {
    await redis.connect();
    const ts = new Date().toISOString();
    await redis.set(WORKER_HEARTBEAT_KEY, ts, "EX", WORKER_HEARTBEAT_TTL_SEC);
    return true;
  } catch {
    return false;
  } finally {
    redis.disconnect();
  }
}

export async function readWorkerHeartbeat(): Promise<string | null> {
  const url = redisUrl();
  if (!url) return null;

  const redis = new Redis(url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });

  try {
    await redis.connect();
    return await redis.get(WORKER_HEARTBEAT_KEY);
  } catch {
    return null;
  } finally {
    redis.disconnect();
  }
}
