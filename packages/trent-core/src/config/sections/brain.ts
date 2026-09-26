/**
 * The `brain` block of `TrentConfigSchema`. Composed in `config/schema.ts`.
 */

import { z } from "zod";

// [C2] brain
/**
 * The brain repository, `<profile>/brain/` (docs/brain.md). Its files are the truth for
 * identity, standing decisions and episodic notes; the memory blocks migrate into
 * `brain/system/` on first use, and every index over it is disposable.
 *
 * `enabled` false means no `brain/` directory is ever created and no brain block reaches a
 * prompt; the memory blocks stay where they are. `versioning` `auto` uses git when it is on
 * PATH, so every write is a commit naming the seat that made it and the run it belonged to;
 * `off` never shells out and the brain is plain files, which `trent doctor` reports as a line,
 * not a failure. Versioning is for audit and rollback, never for merging concurrent writers —
 * that is the memory lock's job.
 */
const BrainCoreConfigSchema = z.object({
  enabled: z.boolean().default(true),
  versioning: z.enum(["auto", "off"]).default("auto"),
});

// [P2-13] rerank
/**
 * `brain.rerank`: a second stage over brain recall (`fleet-memory/rerank.ts`, docs/brain.md). Absent
 * is off. `llm` sends the pool — the top 20 chunks by embedding cosine and the top 20 by TF-IDF —
 * to `model` (default: `models.fast`, else `model`) in ONE call per query; the chunks it scores at or
 * above `min_score` lead the recall, and when none does the block is empty ("no answer here").
 * `max_cents_per_query` bounds the worst case (whole prompt at 3 chars/token plus the full output
 * allowance, at list price); a rerank over it is refused and the blend's order is kept. The spend is
 * metered on the run's ledger rows. Defaults must equal `BRAIN_RERANK_DEFAULTS` (`rerank.test.ts`).
 */
export const BrainRerankConfigSchema = z.object({
  mode: z.enum(["off", "llm"]).default("off"),
  model: z.string().min(1).optional(),
  max_cents_per_query: z.number().positive().default(1),
  min_score: z.number().min(0).max(1).default(0.5),
}).strict();
export type BrainRerankConfig = z.infer<typeof BrainRerankConfigSchema>;
export const BrainConfigSchema = BrainCoreConfigSchema.extend({
  rerank: BrainRerankConfigSchema.optional(),
});
// [/P2-13]
