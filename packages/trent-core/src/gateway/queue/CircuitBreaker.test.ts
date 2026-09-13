import { describe, it, expect } from "vitest";
import { CircuitBreaker } from "./CircuitBreaker.js";

describe("CircuitBreaker", () => {
  it("opens after N consecutive failures, then half-opens after backoff, and closes on success", () => {
    let now = 0;
    const cb = new CircuitBreaker({ failureThreshold: 3, baseBackoffMs: 1000, maxBackoffMs: 8000, now: () => now });
    expect(cb.state()).toBe("closed");
    cb.recordFailure(); cb.recordFailure();
    expect(cb.state()).toBe("closed");
    cb.recordFailure();
    expect(cb.state()).toBe("open");
    expect(cb.canAttempt()).toBe(false);
    now = 999;
    expect(cb.canAttempt()).toBe(false);
    now = 1000;
    expect(cb.canAttempt()).toBe(true);
    expect(cb.state()).toBe("half-open");
    cb.recordSuccess();
    expect(cb.state()).toBe("closed");
    expect(cb.snapshot().consecutiveFailures).toBe(0);
  });

  it("doubles the backoff on every re-open and caps it", () => {
    let now = 0;
    const cb = new CircuitBreaker({ failureThreshold: 1, baseBackoffMs: 1000, maxBackoffMs: 3000, now: () => now });
    cb.recordFailure();
    expect(cb.snapshot().backoffMs).toBe(1000);
    now = 1000; expect(cb.canAttempt()).toBe(true); cb.recordFailure();
    expect(cb.snapshot().backoffMs).toBe(2000);
    now = 3000; expect(cb.canAttempt()).toBe(true); cb.recordFailure();
    expect(cb.snapshot().backoffMs).toBe(3000);
    expect(cb.snapshot().openedAt).toBe(3000);
    expect(cb.snapshot().retryAt).toBe(6000);
  });
});
