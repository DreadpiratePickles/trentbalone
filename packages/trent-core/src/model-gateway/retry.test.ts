/**
 * RED for A.4 / D-6: the gateway makes one attempt per provider, so a 429 is an immediate run
 * failure. These are the classification and backoff rules the retry loop is built on. Offline:
 * no network, no keys, no timers — the delay is computed, never slept.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_RETRY_POLICY,
  ProviderHttpError,
  classifyProviderError,
  parseRetryAfter,
  resolveRetryPolicy,
  retryDelayMs,
} from "./retry.js";

const NOW = Date.parse("2026-09-18T12:00:00Z");

describe("classifyProviderError", () => {
  it("calls 429 a rate limit, retryable, and reads Retry-After in seconds", () => {
    const error = new ProviderHttpError({
      provider: "groq",
      status: 429,
      statusText: "Too Many Requests",
      headers: { "retry-after": "2" },
    });
    expect(classifyProviderError(error, NOW)).toMatchObject({
      errorClass: "rate_limit",
      retryable: true,
      status: 429,
      retryAfterMs: 2_000,
    });
  });

  it("reads Retry-After as an HTTP date", () => {
    const error = new ProviderHttpError({
      provider: "openai",
      status: 429,
      statusText: "Too Many Requests",
      headers: { "retry-after": new Date(NOW + 3_000).toUTCString() },
    });
    expect(classifyProviderError(error, NOW).retryAfterMs).toBe(3_000);
  });

  it("calls 5xx a dependency failure and retries it", () => {
    for (const status of [500, 502, 503, 504]) {
      const classified = classifyProviderError(
        new ProviderHttpError({ provider: "openai", status, statusText: "boom" }),
        NOW,
      );
      expect(classified.errorClass, String(status)).toBe("dependency");
      expect(classified.retryable, String(status)).toBe(true);
    }
  });

  it("never retries a request the provider already rejected", () => {
    const cases: Array<[number, string]> = [
      [400, "validation"],
      [401, "auth"],
      [403, "auth"],
      [404, "validation"],
      [422, "validation"],
    ];
    for (const [status, errorClass] of cases) {
      const classified = classifyProviderError(
        new ProviderHttpError({ provider: "openai", status, statusText: "no" }),
        NOW,
      );
      expect(classified.errorClass, String(status)).toBe(errorClass);
      expect(classified.retryable, String(status)).toBe(false);
    }
  });

  it("retries the transient node network codes and separates a timeout from a reset", () => {
    const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    expect(classifyProviderError(reset, NOW)).toMatchObject({ errorClass: "dependency", retryable: true });

    const timedOut = Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
    expect(classifyProviderError(timedOut, NOW)).toMatchObject({ errorClass: "timeout", retryable: true });

    const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    expect(classifyProviderError(refused, NOW).retryable).toBe(true);
  });

  it("retries an undici fetch failure, including one that only carries its code on `cause`", () => {
    expect(classifyProviderError(new TypeError("fetch failed"), NOW)).toMatchObject({
      errorClass: "dependency",
      retryable: true,
    });
    const wrapped = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    });
    expect(classifyProviderError(wrapped, NOW).retryable).toBe(true);
  });

  it("reads the status off an SDK-shaped error whose headers are a Headers object", () => {
    const error = Object.assign(new Error("429 rate limited"), {
      status: 429,
      headers: new Headers({ "retry-after": "5" }),
    });
    expect(classifyProviderError(error, NOW)).toMatchObject({ status: 429, retryAfterMs: 5_000, retryable: true });
  });

  it("treats anything it cannot classify as internal and does NOT retry it", () => {
    expect(classifyProviderError(new Error("model gateway: fallback chain exhausted"), NOW)).toMatchObject({
      errorClass: "internal",
      retryable: false,
    });
    expect(classifyProviderError("a thrown string", NOW).retryable).toBe(false);
  });
});

describe("ProviderHttpError", () => {
  it("names the provider and status without echoing a credential from the body", () => {
    const error = new ProviderHttpError({
      provider: "anthropic",
      status: 401,
      statusText: "Unauthorized",
      body: '{"error":"invalid x-api-key sk-ant-api03-AAAAAAAABBBBBBBBCCCCCCCC"}',
    });
    expect(error.message).toContain("anthropic");
    expect(error.message).toContain("401");
    expect(error.message).not.toContain("sk-ant-api03-AAAAAAAABBBBBBBBCCCCCCCC");
    expect(error.status).toBe(401);
  });
});

describe("parseRetryAfter", () => {
  it("parses seconds, an HTTP date, and refuses everything else", () => {
    expect(parseRetryAfter("2", NOW)).toBe(2_000);
    expect(parseRetryAfter("0", NOW)).toBe(0);
    expect(parseRetryAfter(new Date(NOW + 90_000).toUTCString(), NOW)).toBe(90_000);
    expect(parseRetryAfter(new Date(NOW - 90_000).toUTCString(), NOW)).toBe(0);
    expect(parseRetryAfter("soon", NOW)).toBeUndefined();
    expect(parseRetryAfter(undefined, NOW)).toBeUndefined();
    expect(parseRetryAfter("-3", NOW)).toBeUndefined();
  });
});

describe("retryDelayMs", () => {
  it("doubles from the base and stops at the cap (full jitter at its ceiling)", () => {
    const policy = DEFAULT_RETRY_POLICY;
    const ceiling = (attempt: number) => retryDelayMs({ attempt, policy, random: () => 1 });
    expect(ceiling(1)).toBe(500);
    expect(ceiling(2)).toBe(1_000);
    expect(ceiling(3)).toBe(2_000);
    expect(ceiling(20)).toBe(policy.capMs);
  });

  it("is full jitter: the floor is 0 and every draw lands inside the window", () => {
    const policy = DEFAULT_RETRY_POLICY;
    expect(retryDelayMs({ attempt: 3, policy, random: () => 0 })).toBe(0);
    for (let i = 0; i < 200; i++) {
      const delay = retryDelayMs({ attempt: 3, policy });
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(2_000);
      expect(Number.isInteger(delay)).toBe(true);
    }
  });

  it("obeys Retry-After exactly when the server sent one, still bounded by the cap", () => {
    const policy = DEFAULT_RETRY_POLICY;
    expect(retryDelayMs({ attempt: 1, policy, retryAfterMs: 2_500, random: () => 0 })).toBe(2_500);
    expect(retryDelayMs({ attempt: 1, policy, retryAfterMs: 600_000, random: () => 0 })).toBe(policy.capMs);
  });
});

describe("resolveRetryPolicy", () => {
  it("defaults to 3 attempts, 500 ms base, 8 s cap — the single place those numbers live", () => {
    expect(DEFAULT_RETRY_POLICY).toEqual({ attempts: 3, baseMs: 500, capMs: 8_000 });
    expect(resolveRetryPolicy(undefined)).toEqual(DEFAULT_RETRY_POLICY);
  });

  it("takes an override per field and ignores a nonsense one instead of disabling retries", () => {
    expect(resolveRetryPolicy({ attempts: 5 })).toEqual({ ...DEFAULT_RETRY_POLICY, attempts: 5 });
    expect(resolveRetryPolicy({ baseMs: 10, capMs: 20 })).toEqual({ attempts: 3, baseMs: 10, capMs: 20 });
    expect(resolveRetryPolicy({ attempts: 0 })).toEqual({ ...DEFAULT_RETRY_POLICY, attempts: 1 });
    expect(resolveRetryPolicy({ attempts: Number.NaN, baseMs: -1, capMs: 0 })).toEqual(DEFAULT_RETRY_POLICY);
  });
});
