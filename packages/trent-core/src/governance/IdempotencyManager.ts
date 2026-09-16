/**
 * Idempotency and side-effect guardrail for Trent Fleet: single execution per key, retry limits
 * per action category, and a dead-letter list for the actions that ran out of attempts.
 *
 * Durability: with a `dir` the rows live in `<dir>/idempotency.json` (see `IdempotencyStore`), so
 * a restarted process finds the completed keys and hands back the stored result instead of
 * re-executing. Without a `dir` the manager is in-memory, which is only right for tests and
 * ephemeral runs.
 *
 * Delivery semantics are at-least-once, not exactly-once: the row is written `in_flight` BEFORE
 * the function runs, and a process that dies between the two leaves that row behind. A later
 * caller with the same key finds `in_flight` with no result and executes again, because the
 * manager cannot know whether the side effect happened. Rows older than `ttlMs` are pruned.
 */
import { createHash } from "node:crypto";
import type { ConfigIO } from "../config/atomic-fs.js";
import { EXIT, TrentError } from "../errors/TrentError.js";
import {
  FileIdempotencyStore,
  MemoryIdempotencyStore,
  type ActionCategory,
  type ActionRecord,
  type IdempotencyStore,
} from "./IdempotencyStore.js";

export type { ActionCategory, ActionRecord, ActionStatus, IdempotencyState } from "./IdempotencyStore.js";

/** Seven days: long past any run, short enough that a profile never accumulates results forever. */
export const DEFAULT_IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface IdempotencyManagerOptions {
  /** Profile directory; the rows are persisted at `<dir>/idempotency.json`. Omit for in-memory. */
  readonly dir?: string;
  readonly io?: ConfigIO;
  readonly now?: () => number;
  readonly ttlMs?: number;
}

/** How a resolved (not thrown) result is recorded. `discard` forgets the row: e.g. an approval pause. */
export type ResultOutcome = "completed" | "failed" | "discard";

export interface ExecuteOptions<T> {
  readonly outcome?: (result: T) => ResultOutcome;
}

export interface IdempotencyResult<T> {
  status: "completed" | "failed" | "discarded";
  result: T;
  cached?: boolean;
}

export interface ToolCallIdentity {
  readonly runId: string;
  readonly stepId: string;
  readonly tool: string;
  readonly args: unknown;
}

/** JSON with object keys sorted at every depth, so equal calls hash equal whatever the model's key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** sha256 over `(runId, stepId, tool, canonical args)`: one key per distinct call within a step. */
export function toolCallKey(identity: ToolCallIdentity): string {
  const material = canonicalJson([identity.runId, identity.stepId, identity.tool, identity.args]);
  return createHash("sha256").update(material).digest("hex");
}

export class IdempotencyRetryLimitError extends TrentError {
  constructor(readonly idempotencyKey: string, readonly limit: number) {
    super({
      code: EXIT.USAGE,
      operation: "governance.idempotency",
      message: `Action execution blocked: Max retry limit (${limit}) exceeded for irreversible action '${idempotencyKey}'. Check dead-letter queue.`,
      target: idempotencyKey,
    });
    this.name = "IdempotencyRetryLimitError";
  }
}

export class IdempotencyManager {
  private readonly store: IdempotencyStore;
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(options: IdempotencyManagerOptions = {}) {
    this.store = options.dir === undefined ? new MemoryIdempotencyStore() : new FileIdempotencyStore(options.dir, options.io);
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;
  }

  private getRetryLimit(category: ActionCategory): number {
    switch (category) {
      case "payment":
      case "social_post":
      case "dns_mutation":
        return 1; // Strictly irreversible
      case "github_pr":
      case "preview_deploy":
        return 3;
      default:
        return 2;
    }
  }

  private stamp(): string {
    return new Date(this.now()).toISOString();
  }

  private expired(row: ActionRecord): boolean {
    return this.now() - Date.parse(row.updatedAt) > this.ttlMs;
  }

  /** Drops rows past the TTL; runs inside every mutation so the file never grows without bound. */
  private prune(state: { records: Record<string, ActionRecord>; deadLetters: ActionRecord[] }): void {
    for (const [key, row] of Object.entries(state.records)) if (this.expired(row)) delete state.records[key];
    state.deadLetters = state.deadLetters.filter((row) => !this.expired(row));
  }

  public async executeWithIdempotency<T>(
    idempotencyKey: string,
    category: ActionCategory,
    fn: () => Promise<T>,
    options: ExecuteOptions<T> = {},
  ): Promise<IdempotencyResult<T>> {
    const limit = this.getRetryLimit(category);
    const stamp = this.stamp();

    // Claim the key: a completed row short-circuits, a blocked row throws, anything else becomes in_flight.
    const claimed = this.store.mutate((state): ActionRecord | { cached: T } => {
      this.prune(state);
      const existing = state.records[idempotencyKey];
      if (existing?.status === "completed") return { cached: existing.result as T };
      if (existing !== undefined) {
        if (existing.status === "dead_letter" || existing.attempts >= limit) throw new IdempotencyRetryLimitError(idempotencyKey, limit);
        existing.attempts += 1;
        existing.status = "in_flight";
        existing.updatedAt = stamp;
        return existing;
      }
      const row: ActionRecord = { idempotencyKey, category, status: "in_flight", attempts: 1, firstSeenAt: stamp, updatedAt: stamp };
      state.records[idempotencyKey] = row;
      return row;
    });
    if ("cached" in claimed) return { status: "completed", result: claimed.cached, cached: true };

    let result: T;
    try {
      result = await fn();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.settleFailure(idempotencyKey, message, limit);
      throw err;
    }

    const outcome = options.outcome?.(result) ?? "completed";
    if (outcome === "discard") {
      this.store.mutate((state) => {
        delete state.records[idempotencyKey];
      });
      return { status: "discarded", result, cached: false };
    }
    if (outcome === "failed") {
      this.settleFailure(idempotencyKey, "the action reported failure", limit);
      return { status: "failed", result, cached: false };
    }
    this.store.mutate((state) => {
      const row = state.records[idempotencyKey];
      if (row === undefined) return;
      row.status = "completed";
      row.result = result;
      row.updatedAt = this.stamp();
    });
    return { status: "completed", result, cached: false };
  }

  private settleFailure(idempotencyKey: string, error: string, limit: number): void {
    this.store.mutate((state) => {
      const row = state.records[idempotencyKey];
      if (row === undefined) return;
      row.error = error;
      row.updatedAt = this.stamp();
      if (row.attempts >= limit) {
        row.status = "dead_letter";
        state.deadLetters.push(structuredClone(row));
      } else {
        row.status = "failed";
      }
    });
  }

  public getDeadLetterQueue(): ActionRecord[] {
    return [...this.store.snapshot().deadLetters];
  }

  /** Every row the manager currently holds, in insertion order. */
  public listRecords(): ActionRecord[] {
    return Object.values(this.store.snapshot().records);
  }

  public clear(): void {
    this.store.mutate((state) => {
      state.records = {};
      state.deadLetters = [];
    });
  }
}
