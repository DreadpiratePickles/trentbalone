/**
 * Session record shape, its schema version, and the one-way migration off the
 * pre-versioning float-dollar format.
 *
 * Two invariants drive this file:
 *  - Money is integer cents everywhere in this codebase. Session records were the last place
 *    still holding floating-point dollars, so `total_cost_cents` is canonical and `total_cost`
 *    survives only as a derived read-only dollars view for existing readers.
 *  - Nothing that reads a session file may assume it was written by the current version. Every
 *    read goes through `migrateSessionRecord`.
 */

import { TrentError, EXIT } from "../errors/index.js";

/** Bumped whenever the on-disk session shape changes. 1 = pre-versioning float dollars. */
export const SESSION_SCHEMA_VERSION = 2;

export interface SessionMessageMetadata {
  /** Canonical cost for this message, integer cents. */
  cost_cents?: number;
  /** @deprecated Derived dollars view. Written for compatibility, never read as truth. */
  cost?: number;
  duration_ms?: number;
  durationMs?: number;
  model?: string;
  tokens?: { prompt: number; completion: number; total: number };
  /**
   * Total tokens when that is all the producer knows. The orchestrator's event stream reports one
   * number per step and never a prompt/completion split, so writing `tokens` would mean inventing
   * the two halves. Additive, so every existing reader of `tokens` is unaffected.
   */
  tokens_total?: number;
  /** The orchestration run that produced this message, when a surface ran one. */
  run_id?: string;
  /**
   * `interrupted` when the user stopped the turn that produced this message. The transcript keeps
   * whatever had streamed — it must not lie about what happened — and readers that re-thread a
   * session into a new run skip these, because a fragment is not an answer.
   */
  status?: "completed" | "interrupted";
  tool_calls?: Array<{ name: string; args: unknown; result: unknown }>;
  files?: string[];
}

export interface SessionMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  agent?: string;
  content: string;
  timestamp: string;
  metadata?: SessionMessageMetadata;
}

export type SessionStatus = "active" | "completed" | "error" | "interrupted";

export interface SessionData {
  schemaVersion: number;
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  agent: string;
  model: string;
  provider: string;
  messages: SessionMessage[];
  status: SessionStatus;
  /** Canonical total cost, integer cents. */
  total_cost_cents: number;
  /** @deprecated Derived dollars view, recomputed on every write. Do not accumulate into it. */
  total_cost: number;
  total_duration_ms: number;
}

/**
 * Dollars to integer cents. `toFixed` first so that 3.4700000000000006 and 0.29 land on the cent
 * they were always meant to be rather than on a binary-float neighbour. Non-finite and negative
 * inputs collapse to 0 — a corrupt cost must not become a negative balance.
 */
export function dollarsToCents(dollars: number): number {
  if (typeof dollars !== "number" || !Number.isFinite(dollars) || dollars <= 0) return 0;
  return Math.round(Number((dollars * 100).toFixed(6)));
}

/** Integer cents back to a dollars view. Presentation only. */
export function centsToDollars(cents: number): number {
  if (!Number.isFinite(cents)) return 0;
  return Math.round(cents) / 100;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

const STATUSES: readonly SessionStatus[] = ["active", "completed", "error", "interrupted"];

function status(value: unknown): SessionStatus {
  return STATUSES.includes(value as SessionStatus) ? (value as SessionStatus) : "completed";
}

function migrateMessage(raw: unknown, index: number): SessionMessage {
  const rec = isRecord(raw) ? raw : {};
  const meta = isRecord(rec.metadata) ? { ...(rec.metadata as SessionMessageMetadata) } : undefined;

  if (meta !== undefined) {
    // v1 stored `cost` in float dollars. Prefer an already-migrated cents value if present.
    const cents =
      typeof meta.cost_cents === "number" && Number.isFinite(meta.cost_cents)
        ? Math.round(meta.cost_cents)
        : dollarsToCents(num(meta.cost, 0));
    if (cents > 0 || meta.cost !== undefined || meta.cost_cents !== undefined) {
      meta.cost_cents = cents;
      meta.cost = centsToDollars(cents);
    }
  }

  const message: SessionMessage = {
    id: str(rec.id, `msg_migrated_${index}`),
    role: (["user", "assistant", "system", "tool"] as const).includes(
      rec.role as SessionMessage["role"],
    )
      ? (rec.role as SessionMessage["role"])
      : "assistant",
    content: str(rec.content, ""),
    timestamp: str(rec.timestamp, new Date(0).toISOString()),
  };
  if (typeof rec.agent === "string") message.agent = rec.agent;
  if (meta !== undefined) message.metadata = meta;
  return message;
}

/**
 * Bring any historical session record up to `SESSION_SCHEMA_VERSION`. Idempotent: running it on a
 * current record returns an equal record. Throws rather than guessing when the input is not a
 * session at all, so the caller can quarantine the file instead of resurrecting a fiction.
 */
export function migrateSessionRecord(raw: unknown): SessionData {
  if (!isRecord(raw) || typeof raw.id !== "string" || raw.id.length === 0) {
    throw new TrentError({
      code: EXIT.CONFIG,
      operation: "session.migrate",
      message: "record is not a session (missing string id)",
    });
  }

  const version = num(raw.schemaVersion, 1);
  const alreadyCents =
    version >= 2 && typeof raw.total_cost_cents === "number" && Number.isFinite(raw.total_cost_cents);
  const totalCents = alreadyCents
    ? Math.round(raw.total_cost_cents as number)
    : dollarsToCents(num(raw.total_cost, 0));

  const now = new Date(0).toISOString();
  const created = str(raw.created_at, now);

  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    id: raw.id,
    title: str(raw.title, "Untitled Session"),
    created_at: created,
    updated_at: str(raw.updated_at, created),
    agent: str(raw.agent, "ceo"),
    model: str(raw.model, "unknown"),
    provider: str(raw.provider, "unknown"),
    messages: Array.isArray(raw.messages) ? raw.messages.map(migrateMessage) : [],
    status: status(raw.status),
    total_cost_cents: totalCents,
    total_cost: centsToDollars(totalCents),
    total_duration_ms: num(raw.total_duration_ms, 0),
  };
}

/** True when the record on disk predates the current schema and a rewrite is warranted. */
export function needsMigration(raw: unknown): boolean {
  return !isRecord(raw) || num(raw.schemaVersion, 1) < SESSION_SCHEMA_VERSION;
}
