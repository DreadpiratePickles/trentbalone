/**
 * Durable outbound queue. A row is persisted before `enqueue` returns, so a crash between
 * enqueue and send loses nothing; a fresh process drains what the old one left. One
 * circuit breaker per platform pauses a flapping transport without blocking the others.
 */

import crypto from "node:crypto";
import type { GatewayStore, QueueRow } from "../store/GatewayStore.js";
import type { OutboundMessage, SendReceipt } from "../transport/types.js";
import { CircuitBreaker, type BreakerSnapshot, type BreakerState, type CircuitBreakerOptions } from "./CircuitBreaker.js";

export type QueueSender = (platform: string, message: OutboundMessage) => Promise<SendReceipt>;

export interface MessageQueueOptions {
  now?: () => number;
  maxAttempts?: number;
  /** Delay before a failed row is retried; independent of the breaker. */
  retryDelayMs?: number;
  breaker?: Omit<CircuitBreakerOptions, "now">;
  /** Called with the platform's receipt after a row is marked sent; a failed attempt never reaches it. */
  onSent?: (row: QueueRow, receipt: SendReceipt) => void;
}

export interface DrainResult {
  sent: number;
  failed: number;
  skipped: number;
  dead: number;
}

export class MessageQueue {
  private readonly now: () => number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly breakerOptions: Omit<CircuitBreakerOptions, "now">;
  private readonly onSent?: (row: QueueRow, receipt: SendReceipt) => void;
  private readonly breakers = new Map<string, CircuitBreaker>();
  private draining = false;
  /** [S2] A drain was asked for while a pass was in flight: that pass goes round again before it settles. */
  private drainAgain = false;

  constructor(
    private readonly store: GatewayStore,
    private readonly sender: QueueSender,
    options: MessageQueueOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.maxAttempts = options.maxAttempts ?? 8;
    this.retryDelayMs = options.retryDelayMs ?? 0;
    this.breakerOptions = options.breaker ?? {};
    this.onSent = options.onSent;
  }

  breaker(platform: string): CircuitBreaker {
    let b = this.breakers.get(platform);
    if (!b) {
      b = new CircuitBreaker({ ...this.breakerOptions, now: this.now });
      this.breakers.set(platform, b);
    }
    return b;
  }

  breakerState(platform: string): BreakerState {
    return this.breaker(platform).state();
  }

  breakerSnapshot(platform: string): BreakerSnapshot {
    return this.breaker(platform).snapshot();
  }

  enqueue(platform: string, message: OutboundMessage): QueueRow {
    const row: QueueRow = {
      id: `msg_${this.now()}_${crypto.randomBytes(4).toString("hex")}`,
      platform,
      message,
      status: "pending",
      attempts: 0,
      createdAt: this.now(),
      nextAttemptAt: this.now(),
    };
    this.store.mutate((s) => {
      s.queue.push(row);
    });
    return row;
  }

  pending(platform?: string): QueueRow[] {
    return this.store
      .snapshot()
      .queue.filter((r) => r.status === "pending" && (platform === undefined || r.platform === platform));
  }

  /** Removes sent rows older than `olderThanMs` so the file does not grow forever. */
  compact(olderThanMs = 24 * 60 * 60 * 1000): number {
    const cutoff = this.now() - olderThanMs;
    return this.store.mutate((s) => {
      const before = s.queue.length;
      s.queue = s.queue.filter((r) => !(r.status === "sent" && (r.sentAt ?? 0) < cutoff));
      return before - s.queue.length;
    });
  }

  /**
   * One pass over every pending row, in insertion order, per-platform breaker respected.
   * [S2] A drain asked for while a pass is in flight is not dropped: that pass read its rows before the
   * caller's row was queued, so it goes round again for the rows it has not tried, before it settles.
   * The caller is not made to wait for it (its result says nothing was sent by this call).
   */
  async drain(): Promise<DrainResult> {
    const result: DrainResult = { sent: 0, failed: 0, skipped: 0, dead: 0 };
    if (this.draining) {
      this.drainAgain = true; // [S2]
      return result;
    }
    this.draining = true;
    const tried = new Set<string>(); // [S2] each row once per drain; a platform that failed stays paused for all of it
    const pausedThisPass = new Set<string>();
    try {
      do { // [S2]
        this.drainAgain = false; // [S2]
        const rows = this.pending().filter((r) => r.nextAttemptAt <= this.now() && !tried.has(r.id)); // [S2] tried
        for (const row of rows) {
          tried.add(row.id); // [S2]
          const breaker = this.breaker(row.platform);
          if (pausedThisPass.has(row.platform) || !breaker.canAttempt()) {
            result.skipped += 1;
            continue;
          }
          try {
            const receipt = await this.sender(row.platform, row.message);
            breaker.recordSuccess();
            this.update(row.id, (r) => {
              r.status = "sent";
              r.attempts += 1;
              r.sentAt = this.now();
              r.lastError = undefined;
            });
            result.sent += 1;
            this.onSent?.(row, receipt);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            breaker.recordFailure(message);
            const dead = row.attempts + 1 >= this.maxAttempts;
            this.update(row.id, (r) => {
              r.attempts += 1;
              r.lastError = message;
              r.nextAttemptAt = this.now() + this.retryDelayMs;
              if (dead) r.status = "dead";
            });
            if (dead) result.dead += 1;
            else result.failed += 1;
            // A failure pauses the rest of this platform for the pass; the breaker decides the next one.
            pausedThisPass.add(row.platform);
          }
        }
      } while (this.drainAgain); // [S2]
    } finally {
      this.draining = false;
    }
    return result;
  }

  private update(id: string, fn: (row: QueueRow) => void): void {
    this.store.mutate((s) => {
      const row = s.queue.find((r) => r.id === id);
      if (row) fn(row);
    });
  }
}
