import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRedisClient } from "./redis";

const OLD_ENV = process.env;

beforeEach(() => {
  vi.restoreAllMocks();
  process.env = { ...OLD_ENV };
  delete process.env.REDIS_URL;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  globalThis.__trentRedis = undefined;
});

afterEach(() => {
  process.env = OLD_ENV;
  globalThis.__trentRedis = undefined;
});

describe("getRedisClient", () => {
  it("uses Upstash REST credentials when present", async () => {
    process.env.REDIS_URL = "redis://broken.example.com:6379";
    process.env.UPSTASH_REDIS_REST_URL = "https://redis.example.com";
    process.env.UPSTASH_REDIS_REST_TOKEN = "token";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ result: 1 }),
    } as Response);

    const client = getRedisClient();
    const count = await client?.incr("rl:test");

    expect(count).toBe(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://redis.example.com",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(["INCR", "rl:test"]),
      })
    );
  });

  it("returns null when no Redis env is configured", () => {
    expect(getRedisClient()).toBeNull();
  });
});
