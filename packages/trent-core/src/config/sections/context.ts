/**
 * The `repl`, `context` and `runtime` blocks of `TrentConfigSchema` — everything that bounds what
 * a turn is told and how many turns run at once. Composed in `config/schema.ts`.
 */

import { z } from "zod";

// [A1] context management
// `history_turns` / `history_chars` were read by `apps/cli/src/repl/conversation.ts` and never
// declared here, so zod stripped both on every load and the profile's setting did nothing.
// `history_chars` is the ONE name for "what the next run may be told"; compaction is keyed off it.
export const ReplConfigSchema = z.object({
  double_text_policy: z.enum(["enqueue", "interrupt", "reject"]).default("enqueue"),
  history_turns: z.number().int().positive().default(8),
  history_chars: z.number().int().positive().default(6000),
});

/**
 * `ceiling_chars` bounds everything the wrapper injects into a seat prompt (the three tiers of
 * `fleet-memory/tiers.ts`); over it, the context and volatile tiers are trimmed oldest-first and
 * the stable tier never is. `compact_after_chars` is where a stored transcript is compacted;
 * omitted, it is `repl.history_chars * 2`. Characters, not tokens: a ceiling must be checkable
 * offline and identically on every provider (docs/configuration.md, "Context management").
 */
export const ContextConfigSchema = z.object({
  ceiling_chars: z.number().int().positive().default(60_000),
  compact_after_chars: z.number().int().positive().optional(),
});

/** `max_concurrent_runs`: runs driven at once per profile; a run past the cap waits FIFO (docs/jobs.md). */
export const RuntimeConfigSchema = z.object({
  max_concurrent_runs: z.number().int().positive().default(2),
});
