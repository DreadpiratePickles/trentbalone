/**
 * The REPL's conversation.
 *
 * Three jobs, deliberately in one small module so the engine keeps only the turn loop:
 *   1. hold the session's messages and hand the next run a bounded transcript
 *      (`DEFAULT_HISTORY_TURNS` turns, `DEFAULT_HISTORY_CHARS` characters, oldest dropped first);
 *   2. fold one run's event stream into the single assistant message that turn produced —
 *      the run's OWN consolidated summary, or the reason it failed. Nothing here writes prose;
 *      an empty stream produces an empty turn and no message is appended;
 *   3. append both messages to the profile's session file through `SessionManager`.
 *
 * The transcript rides ALONGSIDE the objective (`OrchestratorRunOptions.history`), never folded
 * into it: the planner still receives the raw new line, and the fleet-memory hook renders the
 * transcript after its frozen prelude so the cacheable prefix stays byte-stable.
 */

import type { OrcEvent } from "@trent/core/orchestrator/index.js";
import { isCompactionEvent, type SessionMessage } from "@trent/core/sessions/index.js";
import { truncate } from "../ui/index.js";
import { formatCents } from "./budget.js";
import type { ReplConfig } from "./types.js";

/** One prior message of this session, as the run receives it. */
export interface HistoryMessage {
  /** `system` is a compaction summary standing in for turns the transcript no longer holds. */
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
}

/** Turns (a user line plus its answer) threaded into the next run. */
export const DEFAULT_HISTORY_TURNS = 8;
/** Character ceiling for the whole threaded transcript. Oldest messages are dropped first. */
export const DEFAULT_HISTORY_CHARS = 6000;
/** Turns shown in the `--continue` recap. */
export const RECAP_TURNS = 3;

export interface HistoryLimits {
  readonly maxTurns: number;
  readonly maxChars: number;
}

/** `repl.history_turns` / `repl.history_chars` when the profile sets them, else the constants above. */
export function historyLimits(config: ReplConfig): HistoryLimits {
  const repl = typeof config.repl === "object" && config.repl !== null ? (config.repl as Record<string, unknown>) : {};
  const positive = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
  return {
    maxTurns: positive(repl.history_turns, DEFAULT_HISTORY_TURNS),
    maxChars: positive(repl.history_chars, DEFAULT_HISTORY_CHARS),
  };
}

/** The newest turns that fit both bounds, oldest first. */
export function trimHistory(messages: readonly HistoryMessage[], limits: HistoryLimits): HistoryMessage[] {
  const kept = messages.slice(Math.max(0, messages.length - limits.maxTurns * 2));
  let total = kept.reduce((sum, message) => sum + message.content.length, 0);
  let from = 0;
  while (from < kept.length && total > limits.maxChars) {
    total -= kept[from]?.content.length ?? 0;
    from += 1;
  }
  return kept.slice(from);
}

/**
 * What a resumed session threads into the next run.
 *
 * Three rules, each for a reason the transcript cannot express on its own:
 *   - an INTERRUPTED answer stays in the session file but is never re-threaded: a fragment the
 *     user stopped was not this turn's reply, and presenting it as one is worse than silence;
 *   - a COMPACTION event IS threaded, as the `system` turn it is. It is the only thing standing in
 *     for the turns it replaced, so dropping it here would be the silent forgetting that
 *     compaction exists to remove;
 *   - every other `system` or `tool` message is dropped: it is not a turn anybody took.
 */
export function historySeed(messages: readonly SessionMessage[]): HistoryMessage[] {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant" || isCompactionEvent(message))
    .filter((message) => message.metadata?.status !== "interrupted")
    .map((message) => ({ role: message.role as HistoryMessage["role"], content: message.content }));
}

/** What the run reported about the turn. Every field is measured; nothing is defaulted. */
export interface TurnMetadata {
  runId?: string;
  costCents?: number;
  tokensTotal?: number;
  model?: string;
  toolNames?: string[];
  /**
   * `interrupted` when Ctrl+C stopped the turn. Whatever had streamed is still written to the
   * session — the transcript must not lie about what happened — but it is NOT threaded into the
   * next run, because a fragment presented as a completed reply is worse than no reply at all.
   */
  status?: "completed" | "interrupted";
}

/** The slice of `SessionManager` the REPL writes through; the real one satisfies it structurally. */
export interface SessionAppender {
  appendMessage(
    sessionId: string,
    message: {
      role: "user" | "assistant";
      content: string;
      agent?: string;
      metadata?: {
        cost_cents?: number;
        run_id?: string;
        tokens_total?: number;
        model?: string;
        status?: "completed" | "interrupted";
        tool_calls?: Array<{ name: string; args: unknown; result: unknown }>;
      };
    },
  ): unknown;
}

/** Where a recorded turn is persisted. Absent in the engine's own tests; a session file in the REPL. */
export interface ConversationSink {
  user(content: string): void;
  assistant(content: string, metadata: TurnMetadata): void;
}

/**
 * Appends the REPL's turns to a session file, exactly as the gateway handler appends a thread's.
 * `sessionId` is resolved per message, so a session that does not exist yet is created by the
 * first turn rather than by every launch that shows a prompt and is closed again.
 */
export function sessionSink(sessions: SessionAppender, sessionId: () => string, agent: string): ConversationSink {
  return {
    user: (content) => void sessions.appendMessage(sessionId(), { role: "user", content }),
    assistant: (content, metadata) => {
      const meta: NonNullable<Parameters<SessionAppender["appendMessage"]>[1]["metadata"]> = {};
      if (metadata.runId !== undefined) meta.run_id = metadata.runId;
      if (metadata.costCents !== undefined) meta.cost_cents = metadata.costCents;
      if (metadata.tokensTotal !== undefined) meta.tokens_total = metadata.tokensTotal;
      if (metadata.model !== undefined) meta.model = metadata.model;
      if (metadata.status !== undefined) meta.status = metadata.status;
      if (metadata.toolNames !== undefined && metadata.toolNames.length > 0) {
        meta.tool_calls = metadata.toolNames.map((name) => ({ name, args: undefined, result: undefined }));
      }
      sessions.appendMessage(sessionId(), { role: "assistant", agent, content, metadata: meta });
    },
  };
}

export interface ConversationOptions {
  maxTurns?: number;
  maxChars?: number;
  /** Messages restored from a resumed session, oldest first. */
  seed?: readonly HistoryMessage[];
  sink?: ConversationSink;
}

/** The session's messages, bounded on the way out and persisted on the way in. */
export class Conversation {
  readonly #messages: HistoryMessage[];
  readonly #limits: HistoryLimits;
  readonly #sink: ConversationSink | undefined;

  constructor(options: ConversationOptions = {}) {
    this.#messages = [...(options.seed ?? [])];
    this.#limits = {
      maxTurns: options.maxTurns ?? DEFAULT_HISTORY_TURNS,
      maxChars: options.maxChars ?? DEFAULT_HISTORY_CHARS,
    };
    this.#sink = options.sink;
  }

  /** What the next run is told about the turns before it. */
  history(): HistoryMessage[] {
    return trimHistory(this.#messages, this.#limits);
  }

  recordUser(content: string): void {
    if (content.trim() === "") return;
    this.#messages.push({ role: "user", content });
    this.#sink?.user(content);
  }

  /**
   * The turn's answer. An interrupted turn is persisted but never threaded: the next run must not
   * be told that a fragment the user stopped was this turn's reply.
   */
  recordAssistant(content: string, metadata: TurnMetadata): void {
    if (content.trim() === "") return;
    if (metadata.status !== "interrupted") this.#messages.push({ role: "assistant", content });
    this.#sink?.assistant(content, metadata);
  }
}

/** A tool call as the seat loop records it on a step (`apps/web/lib/types.ts` ToolCallRecord). */
interface ToolCallLike {
  adapter?: string;
}

/**
 * One turn's outcome, folded from the run's own events. The assistant message is the run's
 * consolidated summary, or — when the run failed — the reason the `run_failed` frame carried.
 */
export class TurnOutcome {
  #content = "";
  #runId: string | undefined;
  /** Accumulators, not defaults: they start empty and only real reported figures move them. */
  #spent = 0;
  #tokens = 0;
  #model: string | undefined;
  readonly #tools = new Set<string>();

  observe(event: OrcEvent): void {
    if (this.#runId === undefined && event.runId !== "") this.#runId = event.runId;
    if (event.kind === "consolidate_end" || event.kind === "run_done") {
      const summary = event.run?.summary;
      if (summary !== undefined && summary !== "") this.#content = summary;
    }
    if (event.kind === "run_failed") {
      const summary = event.run?.summary;
      if (event.detail !== undefined && event.detail !== "") this.#content = `Run failed: ${event.detail}`;
      else if (summary !== undefined && summary !== "") this.#content = summary;
    }
    if (event.kind === "step_end" || event.kind === "consolidate_end") {
      const cost = event.step?.costCents;
      if (typeof cost === "number" && Number.isInteger(cost)) this.#spent += cost;
      const tokens = event.step?.tokens;
      if (typeof tokens === "number" && Number.isInteger(tokens)) this.#tokens += tokens;
    }
    if (event.step?.model !== undefined) this.#model = event.step.model;
    for (const call of ((event.step as { toolCalls?: ToolCallLike[] } | undefined)?.toolCalls ?? [])) {
      if (call.adapter !== undefined && call.adapter !== "") this.#tools.add(call.adapter);
    }
  }

  get content(): string {
    return this.#content;
  }

  metadata(): TurnMetadata {
    const meta: TurnMetadata = {};
    if (this.#runId !== undefined) meta.runId = this.#runId;
    if (this.#spent > 0) meta.costCents = this.#spent;
    if (this.#tokens > 0) meta.tokensTotal = this.#tokens;
    if (this.#model !== undefined) meta.model = this.#model;
    if (this.#tools.size > 0) meta.toolNames = [...this.#tools];
    return meta;
  }
}

/** The session shape the recap reads; `SessionData` satisfies it structurally. */
export interface RecapSession {
  readonly id: string;
  readonly messages: readonly { readonly role: string; readonly content: string }[];
  readonly total_cost_cents: number;
}

/**
 * The plain-text recap printed when `--continue` restores a session: what is being resumed, what
 * it has already cost, and the last few turns. No colour, no glyphs — the caller themes the lines.
 */
export function recapLines(session: RecapSession, width: number): string[] {
  const turns = session.messages.filter((m) => m.role === "user" || m.role === "assistant");
  const shown = turns.slice(Math.max(0, turns.length - RECAP_TURNS * 2));
  const head = `Resuming session ${session.id}: ${turns.length} message(s), ${formatCents(session.total_cost_cents)} spent.`;
  return [
    head,
    ...shown.map((m) => `  ${m.role}: ${truncate(m.content.replace(/\s+/g, " "), Math.max(20, width - 12))}`),
  ];
}
