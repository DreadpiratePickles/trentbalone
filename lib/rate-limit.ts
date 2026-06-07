import { NextResponse } from "next/server";
import { getRedisClient } from "@/lib/redis";
import { logger } from "@/lib/logger";

export type RateLimitResult = { ok: true } | { ok: false; retryAfterSeconds: number };

const BUCKETS = {
  userGlobal:    { limit: 30,  windowSec: 60 },
  companyGlobal: { limit: 100, windowSec: 60 },
  companyCycle:  { limit: 10,  windowSec: 3600 },
  ipAuth:        { limit: 5,   windowSec: 60 },
} as const;

async function check(
  key: string,
  limit: number,
  windowSec: number,
  failClosed = false
): Promise<RateLimitResult> {
  const redis = getRedisClient();
  if (!redis) {
    return { ok: true };
  }
  try {
    if (redis.status === "wait") {
      await redis.connect();
    }
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, windowSec);
    if (count > limit) {
      const ttl = await redis.ttl(key);
      const retryAfterSeconds = ttl > 0 ? ttl : windowSec;
      logger.warn({ key, count, limit }, "rate_limit.exceeded");
      return { ok: false, retryAfterSeconds };
    }
    return { ok: true };
  } catch (err) {
    logger.error({ err, key }, "rate_limit.redis_error");
    if (failClosed) return { ok: false, retryAfterSeconds: windowSec };
    return { ok: true };
  }
}

export async function checkRateLimit(userId: string, companyId: string): Promise<RateLimitResult> {
  const user = await check(
    `rl:user:${userId}:global`,
    BUCKETS.userGlobal.limit,
    BUCKETS.userGlobal.windowSec
  );
  if (!user.ok) return user;
  return check(
    `rl:company:${companyId}:global`,
    BUCKETS.companyGlobal.limit,
    BUCKETS.companyGlobal.windowSec
  );
}

export async function checkCycleRateLimit(companyId: string): Promise<RateLimitResult> {
  return check(
    `rl:company:${companyId}:cycle`,
    BUCKETS.companyCycle.limit,
    BUCKETS.companyCycle.windowSec
  );
}

export async function checkAuthRateLimit(ip: string): Promise<RateLimitResult> {
  // Email-only auth must not lock out operators when Redis is unavailable.
  // Redis failures are still logged inside check().
  return check(
    `rl:ip:${ip}:auth`,
    BUCKETS.ipAuth.limit,
    BUCKETS.ipAuth.windowSec
  );
}

export function rateLimitExceeded(retryAfterSeconds = 60): NextResponse {
  return NextResponse.json(
    { error: "rate_limit_exceeded", retryAfterSeconds },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } }
  );
}
