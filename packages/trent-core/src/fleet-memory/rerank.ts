/**
 * [P2-13] The brain reranker: a second stage between the hybrid ranker and a seat's prompt.
 *
 * Why. Measured on real documents (01_discovery/output/retrieval-measurement-2026-09-25.md), no
 * reweighting of TF-IDF and the embedding cosine can reach the recall bars: a paraphrase has lexical
 * 0 by construction, so any fusion monotone in both signals ranks it no higher than its cosine rank.
 * And no absolute score separates "no answer" from a weak answer. Both need a judgment of whether a
 * chunk ANSWERS the question, which is what a reranker is.
 *
 * What. The candidate POOL is the top 20 chunks by cosine united with the top 20 by TF-IDF (a zero
 * TF-IDF score is no match), in the blend's order — not the blend's own top 40, which holds far fewer
 * paraphrases. A `BrainReranker` judges the pool; `rerank-llm.ts` is the one that ships, one call per
 * query to the profile's cheapest model. Its outcome is one of:
 *   ranked     its PICKS (the candidates scored at or above `min_score`, best first) lead the recall,
 *              and the rest of what the blend called related follows in the blend's order;
 *   abstained  nothing cleared `min_score`: the block is empty, which is the right answer to a
 *              question the brain cannot answer;
 *   refused    the worst case would cost more than `max_cents_per_query`: the blend's order, uncharged;
 *   failed     the call or its reply failed: the blend's order. Recall never throws for a reranker.
 *
 * Config: `brain.rerank` (`config/sections/brain.ts`), absent is off. Which model: `brain.rerank.model`,
 * else the fast tier (`models.fast`), else the profile's `model`.
 */

import type { ModelGateway } from "../model-gateway/types.js";
import { createLlmReranker } from "./rerank-llm.js";

/** How many candidates each first-stage ranker contributes to the pool. */
export const RERANK_POOL_PER_RANKER = 20;

/** The name a rerank call is metered under on the run's ledger rows (an orchestration role, like `critic`). */
export const RERANK_SEAT = "brain_rerank";

export type RerankMode = "off" | "llm";

/** What the reranker reads of one chunk: its id (never shown to the model), title, heading and text. */
export interface RerankCandidate {
  readonly id: string;
  readonly title: string;
  readonly heading?: string;
  readonly text: string;
}

export interface RerankRequest {
  readonly query: string;
  /** The pool, in the blend's order. */
  readonly candidates: readonly RerankCandidate[];
  /** The run the spend belongs to; its meter tags the ledger row with the run's surface. */
  readonly runId?: string;
  /** The seat whose recall this is. */
  readonly seat?: string;
}

export interface RerankScore {
  readonly id: string;
  /** 0..1: how well the candidate answers the question. */
  readonly score: number;
}

export interface RerankUsage {
  readonly model: string;
  readonly provider: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** The exact list price in micro-cents (1 cent = 1,000,000); the run meter rounds once per run. */
  readonly microCents: number;
  /** The provider reported no usage: the tokens are the gateway's chars/4 estimate. */
  readonly estimated: boolean;
}

export type RerankOutcome =
  | { readonly status: "ranked"; readonly picks: readonly RerankScore[]; readonly scores: readonly RerankScore[]; readonly usage?: RerankUsage }
  | { readonly status: "abstained"; readonly scores: readonly RerankScore[]; readonly usage?: RerankUsage }
  | { readonly status: "refused"; readonly reason: string; readonly estimateMicroCents: number }
  | { readonly status: "failed"; readonly reason: string; readonly usage?: RerankUsage };

export type BrainReranker = (request: RerankRequest) => Promise<RerankOutcome>;

export interface RerankPoolInput {
  readonly ids: readonly string[];
  readonly blend: readonly number[];
  readonly lexical: readonly number[];
  readonly cosines: readonly (number | undefined)[];
  readonly perRanker?: number;
}

function topBy(indices: readonly number[], score: (i: number) => number, ids: readonly string[], n: number): number[] {
  return [...indices].sort((a, b) => score(b) - score(a) || ids[a]!.localeCompare(ids[b]!)).slice(0, n);
}

/** Candidate indices: top-N by cosine united with top-N by TF-IDF (> 0), in the blend's order. */
export function rerankPool(input: RerankPoolInput): number[] {
  const n = input.perRanker ?? RERANK_POOL_PER_RANKER;
  const all = input.ids.map((_, i) => i);
  const withVector = all.filter((i) => input.cosines[i] !== undefined);
  const withTerms = all.filter((i) => (input.lexical[i] ?? 0) > 0);
  const members = new Set([...topBy(withVector, (i) => input.cosines[i]!, input.ids, n), ...topBy(withTerms, (i) => input.lexical[i]!, input.ids, n)]);
  return topBy([...members], (i) => input.blend[i] ?? 0, input.ids, members.size);
}

/** The candidates at or above `minScore`, best first, ties in pool order. Empty means "no answer here". */
export function pickRelevant(scores: readonly RerankScore[], minScore: number, poolOrder: readonly string[]): RerankScore[] {
  const position = new Map(poolOrder.map((id, i) => [id, i] as const));
  const at = (id: string): number => position.get(id) ?? Number.MAX_SAFE_INTEGER;
  return scores.filter((s) => s.score >= minScore).sort((a, b) => b.score - a.score || at(a.id) - at(b.id));
}

/** `brain.rerank` as the parsed config carries it; absent is off. */
export interface BrainRerankSettings {
  readonly mode?: RerankMode;
  readonly model?: string;
  readonly max_cents_per_query?: number;
  readonly min_score?: number;
}

export interface ResolvedBrainRerank {
  readonly mode: RerankMode;
  readonly model?: string;
  readonly max_cents_per_query: number;
  readonly min_score: number;
}

/** The shipped defaults. Must equal the `.default()`s in `config/sections/brain.ts`; its test asserts it. */
export const BRAIN_RERANK_DEFAULTS: ResolvedBrainRerank = { mode: "off", max_cents_per_query: 1, min_score: 0.5 };

export function resolveBrainRerank(raw: BrainRerankSettings | undefined): ResolvedBrainRerank {
  return {
    mode: raw?.mode ?? BRAIN_RERANK_DEFAULTS.mode,
    ...(raw?.model === undefined ? {} : { model: raw.model }),
    max_cents_per_query: raw?.max_cents_per_query ?? BRAIN_RERANK_DEFAULTS.max_cents_per_query,
    min_score: raw?.min_score ?? BRAIN_RERANK_DEFAULTS.min_score,
  };
}

/** Structural view of `TrentConfig`: only what the reranker reads. */
export interface RerankConfigSource {
  readonly model?: string;
  readonly models?: { readonly fast?: string };
  readonly brain?: { readonly rerank?: BrainRerankSettings };
}

/** `brain.rerank.model`, else the fast tier, else the profile's model: the cheapest the profile names. */
export function rerankModelFor(config: RerankConfigSource): string | undefined {
  return config.brain?.rerank?.model ?? config.models?.fast ?? config.model;
}

/**
 * The reranker a profile asked for, or `undefined` when `brain.rerank.mode` is off (the default) or no
 * model can be named. The gateway is the run's own, so the call is routed, retried and priced as every
 * other model call is.
 */
export function rerankerForProfile(config: RerankConfigSource, gateway: Pick<ModelGateway, "complete">): BrainReranker | undefined {
  const settings = resolveBrainRerank(config.brain?.rerank);
  const model = rerankModelFor(config);
  if (settings.mode !== "llm" || model === undefined) return undefined;
  return createLlmReranker({ gateway, model, maxCentsPerQuery: settings.max_cents_per_query, minScore: settings.min_score });
}
