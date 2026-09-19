/**
 * Session compaction — what happens when the stored transcript outgrows what a run may be told.
 *
 * The audit (A.1) found none: a session either fell off the REPL's bounded history silently, or,
 * once threaded, grew until the provider errored. Neither is honest. Compaction is the third
 * option, and it runs in a fixed order:
 *
 *   1. MEMORY FLUSH. The turns that are about to be dropped are OFFERED to the memory write path —
 *      the same `memory` adapter the `memory` tool calls, so block limits and `read_only` are
 *      enforced by the one writer that already enforces them. The offer needs a model call to
 *      decide what is durable; with no gateway, or a gateway that throws, NOTHING is written.
 *   2. SUMMARY. The dropped turns become one summary message. If that call is unavailable the
 *      whole compaction is SKIPPED: dropping turns without recording what they said would be a
 *      silent loss, which is the failure mode this module exists to remove.
 *   3. EVENT. Exactly one compaction record lands in the transcript — a `system` message whose
 *      `metadata.compaction` carries the forgotten message ids, the summary and the before/after
 *      sizes. One event per compaction, so `trent sessions` can show what a session forgot.
 *
 * Two shapes are never split by the boundary: an assistant message that called a tool and the
 * `tool` messages that answer it. A model handed a tool result with no call, or a call with no
 * result, has been given a lie about its own history.
 *
 * Money, ids and timestamps are the caller's: nothing here reads a clock it was not handed except
 * through the defaults, so the same input compacts to the same output.
 */

import crypto from "node:crypto";
import type { SessionMessage } from "./schema.js";

/** The role the compaction event takes. `system` so no reader mistakes it for a turn someone took. */
export const COMPACTION_SUMMARY_ROLE = "system" as const;

/** Prefix on the event's content, so a plain-text reader sees what the message is. */
export const COMPACTION_CONTENT_PREFIX = "Compacted transcript.";

/** The memory block a flush writes to unless the caller names another. */
export const DEFAULT_FLUSH_BLOCK = "memory";

/** Messages always kept verbatim, whatever the budget says: a transcript of one line is not one. */
export const MIN_KEPT_MESSAGES = 2;

export interface CompactionLimits {
  /** `repl.history_chars`: what the next run may be told. The kept tail is trimmed to this. */
  readonly historyChars: number;
  /** `context.compact_after_chars`; defaults to `historyChars * 2`. */
  readonly compactAfterChars?: number;
}

/** What one compaction forgot, recorded on the event message. */
export interface CompactionRecord {
  readonly at: string;
  readonly forgotten: readonly string[];
  readonly summary: string;
  readonly chars_before: number;
  readonly chars_after: number;
}

export type CompactionOutcome =
  | { readonly status: "not_needed" }
  | { readonly status: "skipped"; readonly reason: string }
  | {
      readonly status: "compacted";
      readonly messages: SessionMessage[];
      readonly event: SessionMessage;
      readonly forgotten: readonly string[];
      readonly summary: string;
    };

export interface CompactionInput {
  readonly messages: readonly SessionMessage[];
  readonly limits: CompactionLimits;
  /** Turns the dropped messages into one summary. Throwing means "no model", and nothing compacts. */
  readonly summarise: (dropped: readonly SessionMessage[]) => Promise<string>;
  /** The memory-flush step, run BEFORE the summary. Its failure never blocks compaction. */
  readonly flush?: (dropped: readonly SessionMessage[]) => Promise<void>;
  readonly now?: string;
  readonly newId?: () => string;
}

/** Total content characters of a transcript; the one measure every threshold here uses. */
export function transcriptChars(messages: readonly SessionMessage[]): number {
  return messages.reduce((sum, message) => sum + message.content.length, 0);
}

function compactAfter(limits: CompactionLimits): number {
  const explicit = limits.compactAfterChars;
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) return Math.trunc(explicit);
  return Math.max(1, Math.trunc(limits.historyChars)) * 2;
}

export function shouldCompact(messages: readonly SessionMessage[], limits: CompactionLimits): boolean {
  return transcriptChars(messages) > compactAfter(limits);
}

/** True for a message this module wrote: a compaction event, not a turn anybody took. */
export function isCompactionEvent(message: SessionMessage): boolean {
  return message.role === COMPACTION_SUMMARY_ROLE && message.metadata?.compaction !== undefined;
}

/**
 * Indexes at which the transcript may be cut.
 *
 * A `tool` message belongs to the nearest assistant message before it, and an assistant message
 * that reported `tool_calls` owns every `tool` message that follows it until the next non-tool
 * message. A cut inside such a group would hand the model half a tool exchange, so only the
 * group's first index is a legal boundary.
 */
function boundaries(messages: readonly SessionMessage[]): number[] {
  const legal: number[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i]!.role === "tool") continue;
    const previous = messages[i - 1];
    // An assistant that announced tool calls stays with the tool messages that answer it.
    if (previous?.role === "tool") {
      // `i` closes a tool group; it is a legal boundary because the group ends before it.
      legal.push(i);
      continue;
    }
    legal.push(i);
  }
  legal.push(messages.length);
  return [...new Set(legal)].sort((a, b) => a - b);
}

export interface CompactionPlan {
  readonly drop: SessionMessage[];
  readonly keep: SessionMessage[];
}

/**
 * The newest messages that fit `historyChars`, cut only at a legal boundary, with at least
 * `MIN_KEPT_MESSAGES` kept whatever the budget says.
 */
export function planCompaction(messages: readonly SessionMessage[], limits: CompactionLimits): CompactionPlan {
  const budget = Math.max(1, Math.trunc(limits.historyChars));
  const legal = boundaries(messages).filter((index) => index < messages.length);
  // Newest-first: the latest boundary whose tail still fits, else the latest boundary that keeps
  // the floor. `legal` is ascending, so walking it backwards walks the tail from smallest up.
  let chosen = legal.at(-1) ?? 0;
  for (const index of [...legal].reverse()) {
    const tail = messages.slice(index);
    if (transcriptChars(tail) > budget && tail.length >= MIN_KEPT_MESSAGES) break;
    chosen = index;
  }
  return { drop: messages.slice(0, chosen), keep: messages.slice(chosen) };
}

function eventMessage(record: CompactionRecord, newId: () => string): SessionMessage {
  return {
    id: newId(),
    role: COMPACTION_SUMMARY_ROLE,
    content: `${COMPACTION_CONTENT_PREFIX} ${record.forgotten.length} message(s) forgotten, ${record.chars_before - record.chars_after} chars reclaimed.\n${record.summary}`,
    timestamp: record.at,
    metadata: { compaction: record },
  };
}

function defaultId(): string {
  return `msg_compact_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
}

/**
 * Compact one transcript. Returns the NEW message list; the caller persists it. A transcript under
 * the threshold, or one whose summariser is unavailable, comes back unchanged and says why.
 */
export async function compactSession(input: CompactionInput): Promise<CompactionOutcome> {
  if (!shouldCompact(input.messages, input.limits)) return { status: "not_needed" };
  const { drop, keep } = planCompaction(input.messages, input.limits);
  if (drop.length === 0) return { status: "skipped", reason: "nothing may be dropped without splitting a tool exchange" };

  // 1. The memory flush is offered the turns that are about to go. A failure here is not a reason
  //    to keep an oversized transcript, so it is reported by the flush and never thrown onward.
  if (input.flush) {
    try {
      await input.flush(drop);
    } catch {
      /* the flush reports its own outcome; compaction continues either way */
    }
  }

  // 2. No summary, no compaction: dropping turns with nothing in their place is a silent loss.
  let summary: string;
  try {
    summary = (await input.summarise(drop)).trim();
  } catch (error) {
    return { status: "skipped", reason: `summary unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (summary === "") return { status: "skipped", reason: "the summariser returned nothing" };

  const record: CompactionRecord = {
    at: input.now ?? new Date().toISOString(),
    forgotten: drop.map((message) => message.id),
    summary,
    chars_before: transcriptChars(input.messages),
    chars_after: transcriptChars(keep),
  };
  const event = eventMessage(record, input.newId ?? defaultId);
  return { status: "compacted", messages: [event, ...keep], event, forgotten: record.forgotten, summary };
}

// ── The memory flush ──────────────────────────────────────────────────────────

/** The slice of `MemoryAdapter` the flush uses: exactly what the `memory` tool calls. */
export interface MemoryWritePort {
  execute(action: string, context: { companyId: string }): Promise<{ status: string; summary: string }>;
}

/** The slice of `ModelGateway` the flush uses. Absent means "no model", and nothing is written. */
export interface FlushGateway {
  complete(request: {
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    role: "executor";
    maxTokens: number;
    temperature: number;
  }): Promise<{ text: string; costCents: number }>;
}

export interface MemoryFlushOptions {
  readonly memory: MemoryWritePort;
  readonly companyId: string;
  readonly gateway?: FlushGateway;
  /** The block to write; defaults to `memory`. A `read_only` block is refused by the adapter. */
  readonly block?: string;
  readonly maxTokens?: number;
}

export interface MemoryFlushReport {
  /** `written` when at least one entry landed, `nothing` when the model kept none, */
  /** `unavailable` when there was no usable model call, `refused` when every write was refused. */
  readonly status: "written" | "nothing" | "unavailable" | "refused";
  readonly entries: readonly string[];
  readonly refused: readonly string[];
  readonly costCents: number;
}

const FLUSH_SYSTEM_PROMPT =
  "You are compacting a work session. The turns below are about to leave the model's context for good. " +
  "Return a JSON array of short, durable facts worth keeping in the company's shared memory — decisions made, " +
  "constraints discovered, preferences stated. Return [] if nothing in these turns is durable. " +
  "No commentary, no prose, JSON only.";

function parseEntries(text: string): string[] {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const parsed: unknown = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "").map((entry) => entry.trim());
  } catch {
    return [];
  }
}

function renderTurns(messages: readonly SessionMessage[]): string {
  return messages.map((message) => `${message.role}: ${message.content}`).join("\n\n");
}

/**
 * The flush step `compactSession` takes: one model call over the dropped turns, then one write per
 * durable fact through the `memory` adapter. The adapter owns the block cap and the `read_only`
 * rule, so a refusal here is the adapter's own words, kept for the caller to report.
 */
export function createMemoryFlush(options: MemoryFlushOptions): (dropped: readonly SessionMessage[]) => Promise<MemoryFlushReport> {
  const block = options.block ?? DEFAULT_FLUSH_BLOCK;
  return async (dropped) => {
    const none: MemoryFlushReport = { status: "unavailable", entries: [], refused: [], costCents: 0 };
    if (!options.gateway || dropped.length === 0) return none;

    let text: string;
    let costCents = 0;
    try {
      const completion = await options.gateway.complete({
        messages: [
          { role: "system", content: FLUSH_SYSTEM_PROMPT },
          { role: "user", content: renderTurns(dropped) },
        ],
        role: "executor",
        maxTokens: options.maxTokens ?? 512,
        temperature: 0,
      });
      text = completion.text;
      costCents = Math.max(0, Math.trunc(completion.costCents));
    } catch {
      return none;
    }

    const entries = parseEntries(text);
    if (entries.length === 0) return { status: "nothing", entries: [], refused: [], costCents };

    const written: string[] = [];
    const refused: string[] = [];
    for (const content of entries) {
      const action = `memory ${JSON.stringify({ target: block, action: "add", content })}`;
      const record = await options.memory.execute(action, { companyId: options.companyId });
      if (record.status === "completed") written.push(content);
      else refused.push(record.summary);
    }
    if (written.length > 0) return { status: "written", entries: written, refused, costCents };
    return { status: "refused", entries: [], refused, costCents };
  };
}
