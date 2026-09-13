/**
 * Pauses a flapping platform with exponential backoff instead of retrying forever.
 * closed -> (N consecutive failures) -> open -> (backoff elapsed) -> half-open ->
 * success closes, failure re-opens with doubled backoff up to the cap.
 */

export type BreakerState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  now?: () => number;
}

export interface BreakerSnapshot {
  state: BreakerState;
  consecutiveFailures: number;
  backoffMs: number;
  openedAt: number | null;
  retryAt: number | null;
  lastError?: string;
}

export const DEFAULT_BREAKER = { failureThreshold: 5, baseBackoffMs: 30_000, maxBackoffMs: 15 * 60_000 };

export class CircuitBreaker {
  private readonly threshold: number;
  private readonly base: number;
  private readonly max: number;
  private readonly now: () => number;
  private failures = 0;
  private openCount = 0;
  private openedAt: number | null = null;
  private probing = false;
  private lastError?: string;

  constructor(options: CircuitBreakerOptions = {}) {
    this.threshold = options.failureThreshold ?? DEFAULT_BREAKER.failureThreshold;
    this.base = options.baseBackoffMs ?? DEFAULT_BREAKER.baseBackoffMs;
    this.max = options.maxBackoffMs ?? DEFAULT_BREAKER.maxBackoffMs;
    this.now = options.now ?? (() => Date.now());
  }

  private backoff(): number {
    if (this.openCount === 0) return 0;
    return Math.min(this.max, this.base * 2 ** (this.openCount - 1));
  }

  state(): BreakerState {
    if (this.openedAt === null) return "closed";
    if (this.probing) return "half-open";
    return this.now() - this.openedAt >= this.backoff() ? "half-open" : "open";
  }

  /** True when a send may be attempted now. Entering half-open reserves one probe. */
  canAttempt(): boolean {
    const s = this.state();
    if (s === "closed") return true;
    if (s === "half-open" && !this.probing) {
      this.probing = true;
      return true;
    }
    return false;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openCount = 0;
    this.openedAt = null;
    this.probing = false;
    this.lastError = undefined;
  }

  recordFailure(error?: string): void {
    this.failures += 1;
    this.lastError = error;
    if (this.probing || this.failures >= this.threshold) {
      this.openCount += 1;
      this.openedAt = this.now();
      this.probing = false;
    }
  }

  snapshot(): BreakerSnapshot {
    return {
      state: this.state(),
      consecutiveFailures: this.failures,
      backoffMs: this.backoff(),
      openedAt: this.openedAt,
      retryAt: this.openedAt === null ? null : this.openedAt + this.backoff(),
      lastError: this.lastError,
    };
  }
}
