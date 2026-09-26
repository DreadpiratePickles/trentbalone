/**
 * The `memory` block of `TrentConfigSchema`: the blocks themselves, the embedder that ranks
 * recall, and the two gates over writing them. Composed in `config/schema.ts`, which re-exports
 * every name here.
 */

import { z } from "zod";
import { DEFAULT_MEMORY_BLOCKS, MEMORY_BLOCK_LABEL_PATTERN } from "../../tools/memory/blocks.js";

/**
 * `memory.blocks`: the named memory blocks every seat reads in its prelude (T4.3). Each is one
 * file under `<profile>/memories/` with its own character limit; `read_only` blocks are written
 * by the founder or the heartbeat, never by a seat. Defaults: `memory`, `user`, `company`.
 */
export const MemoryBlockSchema = z.object({
  label: z.string().regex(MEMORY_BLOCK_LABEL_PATTERN),
  file: z.string().min(1),
  description: z.string().min(1),
  limit: z.number().int().positive(),
  read_only: z.boolean().default(false),
});
export type MemoryBlockConfig = z.infer<typeof MemoryBlockSchema>;
// [C3] embedder
/**
 * `memory.embedder`: what ranks fleet recall. Lexical TF-IDF always runs; with an embedder the
 * score is the documented blend of it and the embedding cosine (`fleet-memory/hybrid.ts`).
 * `auto` is the first provider with a key, preferring the one `provider` already routes chat
 * through; `none` is lexical only and is what an operator with no key gets anyway. `model`
 * overrides the route default, `batch_size` bounds one request. `trent doctor` names the live
 * choice. See docs/configuration.md, "Embedder".
 */
export const EmbedderConfigSchema = z.object({
  // [L0-5] local embedder: `ollama`, `lmstudio` and `llamacpp` run on this machine with the runtime's own
  // embedding model (`fleet-memory/embedder-local.ts`); `google` is gemini's other name; `base_url` moves
  // the route's endpoint (a remote Ollama, a proxy) and wins over its environment variable.
  provider: z.enum(["auto", "gemini", "google", "openai", "ollama", "lmstudio", "llamacpp", "none"]).default("auto"),
  model: z.string().min(1).optional(),
  base_url: z.string().url().optional(),
  // [/L0-5]
  batch_size: z.number().int().positive().max(256).default(32),
});
export type EmbedderConfig = z.infer<typeof EmbedderConfigSchema>;
export const MemoryConfigSchema = z.object({
  blocks: z.array(MemoryBlockSchema).default([...DEFAULT_MEMORY_BLOCKS]),
  embedder: EmbedderConfigSchema.default({}),
});
// [/C3]

// [C4] memory gates
/**
 * The memory blocks and the two gates over writing them (docs/configuration.md, "Memory blocks";
 * `tools/memory/store.ts`, `checkMemoryWriteGate`).
 *
 * `consolidation_may_edit` lists the `read_only` block labels the SCHEDULED consolidation may
 * edit. Empty by default, which is the shipped rule: a read-only block is refused on every write
 * path, seat and consolidation alike. Listing a label lets the nightly draft propose changes to
 * that block; a seat is still refused, and the founder still promotes the draft.
 *
 * `consolidation_max_removal_ratio` is the collapse guard. ACE measured a whole-block rewrite
 * taking a context from 18,282 tokens at 66.7 percent to 122 tokens at 57.1 percent in one step,
 * so at most this share of a block's entries may be removed or merged away in ONE consolidation
 * (never fewer than one, so a three-entry block can still lose its duplicate). A proposal over
 * the ratio is rejected whole and ledgered. It must stay equal to `DEFAULT_MAX_REMOVAL_RATIO`
 * in `fleet-memory/memory-ops.ts`, which `tools/memory/memory.test.ts` asserts.
 */
export const MemoryGatesConfigSchema = MemoryConfigSchema.extend({
  consolidation_may_edit: z.array(z.string().regex(MEMORY_BLOCK_LABEL_PATTERN)).default([]),
  consolidation_max_removal_ratio: z.number().positive().max(1).default(0.3),
  // [C1] app memory
  /**
   * Characters of candidate text taken from each surface of the web app's own company memory
   * before the recall ranker sees it (docs/configuration.md, "Company memory in the app";
   * `fleet-memory/app-tiers.ts`). `tiers` is the three tiers of `memory-tiers.ts` (working,
   * episodic, semantic, superseded facts excluded), `documents` the company's other documents
   * inside their validity window, `capabilities` this seat's capability outcomes, `registries`
   * this seat's compounding registry, `decisions` the CEO decision journal and `wiki` the
   * company's wiki notes. The budget bounds what the ranker scores and therefore what this tier
   * can add to the assembled injection; the sum stays well under `context.ceiling_chars`. Zero
   * turns one surface off without touching the others. Must stay equal to
   * `DEFAULT_APP_MEMORY_BUDGETS` in `fleet-memory/app-tiers.ts`, which its suite asserts.
   */
  app_sources: z.object({
    tiers: z.number().int().nonnegative().default(4_000),
    documents: z.number().int().nonnegative().default(4_000),
    capabilities: z.number().int().nonnegative().default(1_500),
    registries: z.number().int().nonnegative().default(1_500),
    decisions: z.number().int().nonnegative().default(1_500),
    wiki: z.number().int().nonnegative().default(1_500),
  }).strict().default({}),
  // [/C1]
});
