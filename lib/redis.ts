import Redis from "ioredis";

export type RedisRateLimitClient = Pick<Redis, "incr" | "expire" | "ttl" | "connect" | "status">;

class UpstashRedisRestClient implements RedisRateLimitClient {
  status = "ready" as const;

  constructor(
    private readonly url: string,
    private readonly token: string
  ) {}

  async connect(): Promise<void> {}

  async incr(key: string): Promise<number> {
    return Number(await this.command("INCR", key));
  }

  async expire(key: string, seconds: number): Promise<number> {
    return Number(await this.command("EXPIRE", key, seconds));
  }

  async ttl(key: string): Promise<number> {
    return Number(await this.command("TTL", key));
  }

  private async command(command: string, ...args: Array<string | number>): Promise<unknown> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify([command, ...args]),
    });
    const body = await response.json() as { result?: unknown; error?: string };
    if (!response.ok || body.error) {
      throw new Error(body.error ?? `Upstash Redis command failed: ${response.status}`);
    }
    return body.result;
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __trentRedis: RedisRateLimitClient | undefined;
}

export function getRedisClient(): RedisRateLimitClient | null {
  const restUrl = process.env.UPSTASH_REDIS_REST_URL;
  const restToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (restUrl && restToken) {
    if (!globalThis.__trentRedis) {
      globalThis.__trentRedis = new UpstashRedisRestClient(restUrl, restToken);
    }
    return globalThis.__trentRedis;
  }

  const url = process.env.REDIS_URL;
  if (!url) return null;
  if (!globalThis.__trentRedis) {
    const redis = new Redis(url, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });
    redis.on("error", () => {});
    globalThis.__trentRedis = redis;
  }
  return globalThis.__trentRedis;
}
