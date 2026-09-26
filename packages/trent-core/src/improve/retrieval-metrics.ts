/**
 * [P2-6] recall@8, recall@3 and MRR@8 per ranking mode and per question category, over a golden set
 * resolved by `docs-corpus.ts`. Every number comes out of the shipped evaluator
 * (`fleet-memory/retrieval-eval.ts` `evaluateRetrieval`, k = 8): this module only slices its
 * per-query ranks and adds the no-answer questions, which the evaluator has no notion of.
 *
 * The three modes:
 *   - `lexical`   the shipped ranker with no embedder: TF-IDF, related at `recallMinScore` (0.12).
 *                 What an offline sweep and `trent improve retrieval` measure without a key.
 *   - `hybrid`    the shipped ranker with the embedder: 0.4 TF-IDF + 0.6 calibrated cosine credit.
 *                 What a seat's prompt gets on a profile with a Gemini or OpenAI key.
 *   - `embedding` the dense half alone, through the evaluator's `rank` seam: the same text the
 *                 hybrid embeds, ranked by cosine, kept above the embedder's own calibrated floor
 *                 (the line under which the blend gives a cosine no credit). Measurement only; no
 *                 surface ships it.
 *
 * A no-answer question passes ("abstains") when the ranker returns nothing it considers related —
 * the only notion of confidence the shipped ranker has. Its top score is reported beside the
 * weakest top score of an answered question, so a reader can see whether any threshold would
 * separate them.
 */
import type { Brain } from "../fleet-memory/brain.js";
import { loadBrainIndex, recallFromBrain, type BrainRerankReport } from "../fleet-memory/brain-index.js";
import type { BrainReranker } from "../fleet-memory/rerank.js";
import { HYBRID_VECTOR_FLOOR } from "../fleet-memory/hybrid.js";
import { cosineSimilarity, type CalibratedEmbedFn, type EmbedFn, type EmbedRole } from "../fleet-memory/lexical.js";
import {
  DEFAULT_RECALL_K,
  RETRIEVAL_EVAL_SEAT,
  brainRanker,
  evaluateRetrieval,
  type RankedChunk,
  type RetrievalEvalResult,
  type RetrievalQueryResult,
  type RetrievalRanker,
} from "../fleet-memory/retrieval-eval.js";
import { chunkScorableText, type AnswerableCategory, type DocsCorpusGolden, type NoAnswerQuestion } from "./docs-corpus.js";

export const RETRIEVAL_MODES = ["lexical", "embedding", "hybrid"] as const;
/** The first-stage modes, plus [P2-13] `rerank` (the hybrid with the reranker over its pool) and labelled variants. */
export type RetrievalMode = (typeof RETRIEVAL_MODES)[number] | "rerank" | (string & {});
export const ANSWERABLE_CATEGORIES: readonly AnswerableCategory[] = ["exact_term", "paraphrased", "multi_hop"];
/** The tighter cut reported beside the gate's k. */
export const RECALL_TIGHT_K = 3;

/** The dense half alone (see the header): cosine order above the embedder's calibrated floor. */
export function embeddingOnlyRanker(options: { readonly brain: Brain; readonly embed: EmbedFn }): RetrievalRanker {
  // [P2-13] Asymmetric like brain recall: chunks as documents, the question as the query, and the
  // task-typed floor when the embedder applies roles.
  const calibrated = options.embed as CalibratedEmbedFn;
  const floor = calibrated.queryFloor ?? calibrated.vectorFloor ?? HYBRID_VECTOR_FLOOR;
  return async (query, seat) => {
    const entries = loadBrainIndex({ profileDir: options.brain.profileDir, brain: options.brain }).entries.filter((e) => e.seat === undefined || e.seat === seat);
    if (entries.length === 0) return [];
    const vectors = await options.embed([...entries.map(chunkScorableText), query], { roles: [...entries.map((): EmbedRole => "document"), "query"] });
    const q = vectors[vectors.length - 1];
    if (q === undefined || q.length === 0) throw new Error("the embedder returned no vector for the query");
    return entries
      .map((entry, i) => ({ entry, cosine: vectors[i] === undefined || vectors[i]!.length === 0 ? 0 : cosineSimilarity(vectors[i]!, q) }))
      .filter((c) => c.cosine > floor)
      .sort((a, b) => b.cosine - a.cosine || a.entry.id.localeCompare(b.entry.id))
      .map(({ entry, cosine }): RankedChunk => ({ id: entry.id, path: entry.path, ...(entry.page === undefined ? {} : { page: entry.page }), score: cosine }));
  };
}

/**
 * [P2-13] The shipped brain recall with a reranker: the blend, the pool, the reranker's picks, then
 * the rest of the blend. Every recall's rerank report is handed to `onReport` against its query, so a
 * measurement can count outcomes and spend.
 */
export function rerankedRanker(options: { readonly brain: Brain; readonly embed?: EmbedFn; readonly rerank: BrainReranker; readonly onReport?: (query: string, report: BrainRerankReport | undefined) => void }): RetrievalRanker {
  return async (query, seat) => {
    const result = await recallFromBrain({
      profileDir: options.brain.profileDir,
      brain: options.brain,
      seat,
      objective: query,
      budgetChars: Number.MAX_SAFE_INTEGER,
      rerank: options.rerank,
      ...(options.embed === undefined ? {} : { embed: options.embed }),
    });
    options.onReport?.(query, result.rerank);
    return result.items.map((item) => ({ id: item.id, path: item.path, ...(item.page === undefined ? {} : { page: item.page }), score: item.score }));
  };
}

/** [P2-13] What the reranks of one measurement did and cost: outcome counts and micro-cents per query. */
export interface RerankSpendSummary {
  readonly queries: number;
  readonly statuses: Readonly<Record<string, number>>;
  readonly totalMicroCents: number;
  readonly meanCentsPerQuery: number;
  readonly maxCentsPerQuery: number;
}

export function summariseReranks(reports: ReadonlyMap<string, BrainRerankReport | undefined>): RerankSpendSummary {
  const statuses: Record<string, number> = {};
  let total = 0;
  let max = 0;
  for (const report of reports.values()) {
    const status = report?.status ?? "none";
    statuses[status] = (statuses[status] ?? 0) + 1;
    total += report?.microCents ?? 0;
    max = Math.max(max, report?.microCents ?? 0);
  }
  const n = reports.size;
  return { queries: n, statuses, totalMicroCents: total, meanCentsPerQuery: n === 0 ? 0 : total / n / 1_000_000, maxCentsPerQuery: max / 1_000_000 };
}

/** The ranker a mode measures. `embed` is required for `embedding` and `hybrid`. */
export function rankerFor(mode: (typeof RETRIEVAL_MODES)[number], brain: Brain, embed?: EmbedFn): RetrievalRanker {
  if (mode === "lexical") return brainRanker({ brain });
  if (embed === undefined) throw new Error(`the ${mode} mode needs an embedder`);
  return mode === "hybrid" ? brainRanker({ brain, embed }) : embeddingOnlyRanker({ brain, embed });
}

export interface RecallSummary {
  readonly queries: number;
  readonly hitsAt8: number;
  readonly hitsAt3: number;
  readonly recallAt8: number;
  readonly recallAt3: number;
  /** Mean reciprocal rank of the first expected chunk, 0 for a question outside the top 8. */
  readonly mrr: number;
}

export function summariseRanks(ranks: readonly (number | null)[]): RecallSummary {
  const n = ranks.length;
  const hitsAt8 = ranks.filter((r) => r !== null && r <= DEFAULT_RECALL_K).length;
  const hitsAt3 = ranks.filter((r) => r !== null && r <= RECALL_TIGHT_K).length;
  const rr = ranks.reduce<number>((sum, r) => sum + (r === null || r > DEFAULT_RECALL_K ? 0 : 1 / r), 0);
  return { queries: n, hitsAt8, hitsAt3, recallAt8: n === 0 ? 0 : hitsAt8 / n, recallAt3: n === 0 ? 0 : hitsAt3 / n, mrr: n === 0 ? 0 : rr / n };
}

export interface MeasuredQuery extends RetrievalQueryResult {
  readonly category: AnswerableCategory;
  /** The score of the ranker's first result, or null when it returned nothing. */
  readonly topScore: number | null;
}

export interface NoAnswerResult {
  readonly id: string;
  readonly query: string;
  readonly abstained: boolean;
  readonly top: { readonly id: string; readonly score: number } | null;
}

export interface ModeReport {
  readonly mode: RetrievalMode;
  /** The shipped evaluator's own result, which the gate's grader (`retrieval-gate.ts`) reads. */
  readonly evaluation: RetrievalEvalResult;
  readonly overall: RecallSummary;
  readonly byCategory: Readonly<Record<AnswerableCategory, RecallSummary>>;
  readonly perQuery: readonly MeasuredQuery[];
  readonly noAnswer: { readonly queries: number; readonly abstained: number; readonly perQuery: readonly NoAnswerResult[] };
  /** The weakest first-place score among questions answered at rank 1; null when none were. */
  readonly weakestAnsweredTopScore: number | null;
}

export interface MeasureModeInput {
  readonly mode: RetrievalMode;
  readonly brain: Brain;
  readonly rank: RetrievalRanker;
  readonly answerable: readonly DocsCorpusGolden[];
  readonly noAnswer: readonly NoAnswerQuestion[];
}

/**
 * A macrotask turn between questions. TF-IDF over 625 chunks is ~0.35 s of synchronous work per
 * question and every await in between resolves as a microtask, so without this a 40-question
 * measurement holds the event loop for a minute and a test worker's RPC times out under it.
 */
const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export async function measureMode(input: MeasureModeInput): Promise<ModeReport> {
  const topScores = new Map<string, number | null>();
  const recording: RetrievalRanker = async (query, seat) => {
    await yieldToEventLoop();
    const ranked = await input.rank(query, seat);
    topScores.set(query, ranked[0]?.score ?? null);
    return ranked;
  };
  const result = await evaluateRetrieval(input.brain, input.answerable, { rank: recording, k: DEFAULT_RECALL_K });
  const perQuery: MeasuredQuery[] = result.perQuery.map((q, i) => ({ ...q, category: input.answerable[i]!.category, topScore: topScores.get(q.query) ?? null }));
  const byCategory = Object.fromEntries(
    ANSWERABLE_CATEGORIES.map((category) => [category, summariseRanks(perQuery.filter((q) => q.category === category).map((q) => q.rank))]),
  ) as Record<AnswerableCategory, RecallSummary>;

  const noAnswer: NoAnswerResult[] = [];
  for (const q of input.noAnswer) {
    await yieldToEventLoop();
    const ranked = await input.rank(q.query, RETRIEVAL_EVAL_SEAT);
    const first = ranked[0];
    noAnswer.push({ id: q.id, query: q.query, abstained: first === undefined, top: first === undefined ? null : { id: first.id, score: first.score } });
  }
  const answeredFirst = perQuery.filter((q) => q.rank === 1 && q.topScore !== null).map((q) => q.topScore!);
  return {
    mode: input.mode,
    evaluation: result,
    overall: summariseRanks(perQuery.map((q) => q.rank)),
    byCategory,
    perQuery,
    noAnswer: { queries: noAnswer.length, abstained: noAnswer.filter((q) => q.abstained).length, perQuery: noAnswer },
    weakestAnsweredTopScore: answeredFirst.length === 0 ? null : Math.min(...answeredFirst),
  };
}

const pct = (x: number): string => x.toFixed(3);

/** The report as the Markdown tables the measurement document carries: mode x metric, then per category. */
export function formatModeTables(reports: readonly ModeReport[]): string {
  const lines = ["| mode | recall@8 | recall@3 | MRR@8 | no-answer abstained |", "|---|---:|---:|---:|---:|"];
  for (const r of reports) {
    lines.push(`| ${r.mode} | ${pct(r.overall.recallAt8)} (${String(r.overall.hitsAt8)}/${String(r.overall.queries)}) | ${pct(r.overall.recallAt3)} | ${pct(r.overall.mrr)} | ${String(r.noAnswer.abstained)}/${String(r.noAnswer.queries)} |`);
  }
  lines.push("", "| mode | category | n | recall@8 | recall@3 | MRR@8 |", "|---|---|---:|---:|---:|---:|");
  for (const r of reports) {
    for (const category of ANSWERABLE_CATEGORIES) {
      const s = r.byCategory[category];
      lines.push(`| ${r.mode} | ${category} | ${String(s.queries)} | ${pct(s.recallAt8)} | ${pct(s.recallAt3)} | ${pct(s.mrr)} |`);
    }
  }
  return lines.join("\n");
}
