/**
 * The CLI's context ceilings, its personality resolution, and its session compactor.
 *
 * Three small jobs that all answer the same question — what may a prompt contain, and what happens
 * when the answer is "less than the session has":
 *
 *   1. `contextLimits` reads `context.ceiling_chars`, `repl.history_chars` and
 *      `context.compact_after_chars` off the profile. One name per number: `repl.history_chars`
 *      is "what the next run may be told" and compaction is keyed off it, doubled by default.
 *   2. `personalitySuffix` resolves the active personality's `systemPromptSuffix`. It reaches the
 *      VOLATILE tier of the wrapper's injection and nothing else — never the system prompt, never
 *      the protected seat prompt (`improve/protected-prompt.ts`).
 *   3. `createSessionCompactor` compacts one stored session: the turns about to be dropped are
 *      offered to the `memory` write path, then summarised into one message, and one compaction
 *      event records the forgotten ids. The gateway is built lazily — a session that never crosses
 *      the threshold never constructs one — and with no gateway nothing is dropped at all.
 *
 * Nothing here logs a prompt body, a memory entry or a transcript line.
 */

import type { ConfigManager } from "@trent/core";
import { PersonalityManager } from "@trent/core/personalities/index.js";
import {
  compactSession,
  createMemoryFlush,
  type CompactionOutcome,
  type FlushGateway,
  type MemoryWritePort,
  type SessionData,
  type SessionMessage,
} from "@trent/core/sessions/index.js";
import type { ReplConfig } from "./types.js";

/** Mirrors `config/defaults.ts`; a surface that runs before a config is loaded still has numbers. */
export const DEFAULT_CEILING_CHARS = 60_000;
export const DEFAULT_HISTORY_CHARS = 6000;

export interface ContextLimits {
  /** `context.ceiling_chars`: the whole wrapper injection for one seat call. */
  readonly ceilingChars: number;
  /** `repl.history_chars`: what the next run may be told about the turns before it. */
  readonly historyChars: number;
  /** `context.compact_after_chars`, or twice the history budget. */
  readonly compactAfterChars: number;
}

function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function section(config: ReplConfig, key: "context" | "repl"): Record<string, unknown> {
  const raw = (config as unknown as Record<string, unknown>)[key];
  return typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
}

export function contextLimits(config: ReplConfig): ContextLimits {
  const context = section(config, "context");
  const repl = section(config, "repl");
  const historyChars = positive(repl.history_chars, DEFAULT_HISTORY_CHARS);
  return {
    ceilingChars: positive(context.ceiling_chars, DEFAULT_CEILING_CHARS),
    historyChars,
    compactAfterChars: positive(context.compact_after_chars, historyChars * 2),
  };
}

/**
 * The active personality's suffix, or `undefined` when it has none.
 *
 * `personality: "default"` is a personality like any other and carries a real tone stance, so the
 * default profile does inject one line. That is the point of the setting: the audit found it
 * reaching no prompt at all, which made `trent personality` a command that changed nothing.
 */
export function personalitySuffix(configManager?: ConfigManager): string | undefined {
  const suffix = new PersonalityManager(configManager).getActivePersonality().systemPromptSuffix.trim();
  return suffix === "" ? undefined : suffix;
}

/** The slice of `SessionManager` the compactor reads and writes; the real one satisfies it. */
export interface CompactorSessions {
  getSession(sessionId: string): SessionData | null;
  getStore(): { save(session: SessionData): unknown };
}

export interface SessionCompactorDeps {
  readonly sessions: CompactorSessions;
  readonly companyId: string;
  readonly limits: ContextLimits;
  /** Built on demand, once, and only when a transcript actually crosses the threshold. */
  readonly gateway: () => Promise<FlushGateway | undefined>;
  /** The shared `memory` adapter; without it the flush step is skipped and only the summary runs. */
  readonly memory?: MemoryWritePort;
  readonly maxTokens?: number;
}

const SUMMARY_SYSTEM_PROMPT =
  "You are compacting a work session. Summarise the turns below into one short paragraph that a " +
  "colleague could read to know what was asked, what was decided and what is still open. Keep names, " +
  "file paths, ids and numbers exactly as written. No preamble, no bullet list, no commentary.";

function renderTurns(messages: readonly SessionMessage[]): string {
  return messages.map((message) => `${message.role}: ${message.content}`).join("\n\n");
}

/**
 * Compacts one stored session in place. Returns what happened so a surface can say it out loud;
 * `not_needed` and `skipped` both leave the session file byte-identical.
 */
export function createSessionCompactor(deps: SessionCompactorDeps): (sessionId: string) => Promise<CompactionOutcome> {
  let resolved: Promise<FlushGateway | undefined> | undefined;
  const gatewayOnce = (): Promise<FlushGateway | undefined> => (resolved ??= deps.gateway().catch(() => undefined));

  return async (sessionId) => {
    const session = deps.sessions.getSession(sessionId);
    if (!session) return { status: "skipped", reason: `session ${sessionId} not found` };

    const outcome = await compactSession({
      messages: session.messages,
      limits: { historyChars: deps.limits.historyChars, compactAfterChars: deps.limits.compactAfterChars },
      ...(deps.memory === undefined
        ? {}
        : {
            flush: async (dropped) => {
              const gateway = await gatewayOnce();
              if (!gateway || !deps.memory) return;
              await createMemoryFlush({
                memory: deps.memory,
                companyId: deps.companyId,
                gateway,
                ...(deps.maxTokens === undefined ? {} : { maxTokens: deps.maxTokens }),
              })(dropped);
            },
          }),
      summarise: async (dropped) => {
        const gateway = await gatewayOnce();
        if (!gateway) throw new Error("no model gateway is available to summarise the dropped turns");
        const completion = await gateway.complete({
          messages: [
            { role: "system", content: SUMMARY_SYSTEM_PROMPT },
            { role: "user", content: renderTurns(dropped) },
          ],
          role: "executor",
          maxTokens: deps.maxTokens ?? 512,
          temperature: 0,
        });
        return completion.text;
      },
    });

    if (outcome.status === "compacted") {
      deps.sessions.getStore().save({ ...session, messages: outcome.messages });
    }
    return outcome;
  };
}
