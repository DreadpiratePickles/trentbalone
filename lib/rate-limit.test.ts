import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetRedisClient, mockConnect, mockIncr, mockExpire, mockTtl } = vi.hoisted(() => ({
  mockGetRedisClient: vi.fn(),
  mockConnect: vi.fn(),
  mockIncr: vi.fn(),
  mockExpire: vi.fn(),
  mockTtl: vi.fn(),
}));

vi.mock("@/lib/redis", () => ({
  getRedisClient: mockGetRedisClient,
}));

import {
  checkRateLimit,
  checkCycleRateLimit,
  checkAuthRateLimit,
  rateLimitExceeded,
} from "./rate-limit";

beforeEach(() => {
  mockGetRedisClient.mockReset();
  mockConnect.mockReset();
  mockIncr.mockReset();
  mockExpire.mockReset();
  mockTtl.mockReset();
  mockGetRedisClient.mockReturnValue({
    status: "ready",
    connect: mockConnect,
    incr: mockIncr,
    expire: mockExpire,
    ttl: mockTtl,
  });
  mockConnect.mockResolvedValue(undefined);
  mockExpire.mockResolvedValue(1);
  mockTtl.mockResolvedValue(55);
});

describe("checkRateLimit", () => {
  it("returns ok:true on first request", async () => {
    mockIncr.mockResolvedValue(1);
    const result = await checkRateLimit("user_1", "co_1");
    expect(result.ok).toBe(true);
  });

  it("sets EXPIRE only when count is 1", async () => {
    mockIncr.mockResolvedValue(1);
    await checkRateLimit("user_1", "co_1");
    expect(mockExpire).toHaveBeenCalledWith("rl:user:user_1:global", 60);
  });

  it("does not call EXPIRE when count > 1", async () => {
    mockIncr.mockResolvedValue(5);
    await checkRateLimit("user_1", "co_1");
    expect(mockExpire).not.toHaveBeenCalled();
  });

  it("returns ok:false with retryAfterSeconds when user limit exceeded", async () => {
    mockIncr.mockResolvedValueOnce(31); // user bucket over limit
    mockTtl.mockResolvedValue(42);
    const result = await checkRateLimit("user_1", "co_1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryAfterSeconds).toBe(42);
  });

  it("returns ok:false when company limit exceeded", async () => {
    mockIncr
      .mockResolvedValueOnce(1)    // user bucket OK
      .mockResolvedValueOnce(101); // company bucket over limit
    mockTtl.mockResolvedValue(30);
    const result = await checkRateLimit("user_1", "co_1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryAfterSeconds).toBe(30);
  });

  it("fails open on Redis error (non-auth routes)", async () => {
    mockIncr.mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await checkRateLimit("user_1", "co_1");
    expect(result.ok).toBe(true);
  });
});

describe("checkCycleRateLimit", () => {
  it("returns ok:false with retryAfterSeconds when cycle limit exceeded", async () => {
    mockIncr.mockResolvedValue(11);
    mockTtl.mockResolvedValue(1800);
    const result = await checkCycleRateLimit("co_1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryAfterSeconds).toBe(1800);
  });

  it("uses a 1-hour window key", async () => {
    mockIncr.mockResolvedValue(1);
    await checkCycleRateLimit("co_1");
    expect(mockExpire).toHaveBeenCalledWith("rl:company:co_1:cycle", 3600);
  });
});

describe("checkAuthRateLimit", () => {
  it("returns ok:false when IP auth limit exceeded", async () => {
    mockIncr.mockResolvedValue(6);
    mockTtl.mockResolvedValue(45);
    const result = await checkAuthRateLimit("1.2.3.4");
    expect(result.ok).toBe(false);
  });

  it("connects a lazy Redis client before issuing auth commands", async () => {
    mockGetRedisClient.mockReturnValue({
      status: "wait",
      connect: mockConnect,
      incr: mockIncr,
      expire: mockExpire,
      ttl: mockTtl,
    });
    mockIncr.mockResolvedValue(1);

    const result = await checkAuthRateLimit("1.2.3.4");

    expect(result.ok).toBe(true);
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockIncr).toHaveBeenCalledWith("rl:ip:1.2.3.4:auth");
  });

  it("fails open on Redis error", async () => {
    mockIncr.mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await checkAuthRateLimit("1.2.3.4");
    expect(result.ok).toBe(true);
  });

  it("fails open when Redis client is unavailable", async () => {
    mockGetRedisClient.mockReturnValue(null);
    const result = await checkAuthRateLimit("1.2.3.4");
    expect(result.ok).toBe(true);
  });
});

describe("rateLimitExceeded", () => {
  it("returns 429 with Retry-After header and JSON body", async () => {
    const res = rateLimitExceeded(60);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    const body = await res.json() as { error: string; retryAfterSeconds: number };
    expect(body.error).toBe("rate_limit_exceeded");
    expect(body.retryAfterSeconds).toBe(60);
  });
});
