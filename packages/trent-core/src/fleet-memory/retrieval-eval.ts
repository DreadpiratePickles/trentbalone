/**
 * [W3] recall@k over the retrieval golden set: the number every later change to ingestion,
 * chunking, ranking or reranking is judged by (harness upgrade audit, section 4 item 3).
 *
 * Ids in, ids out, a number (audit section 5: no LLM judge for retrieval). A golden is a query and
 * the chunk ids that answer it; the ranker under test is asked the query and a golden is a HIT
 * when any expected id — or any chunk of the expected document, on the expected page when one is
 * named — is in the top `k`. recall@k is the share of goldens that hit. Nothing here samples,
 * calls a model or reads a clock: the same brain, the same goldens and the same embedder give the
 * same number on every machine, which is what lets a floor be a gate.
 *
 * The ranker is the shipped one, `recallFromBrain` over the profile's brain index with whatever
 * embedder the profile configured (or none, which is the lexical ranker). It is also a SEAM: the
 * gate's own test hands in a ranker patched to return the reverse order and asserts the floor
 * refuses it with the metric named, and a reranker or a contextual-prefix change is measured by
 * handing in itself. The budget cut the prompt applies is not part of the ranker, so the ranker
 * is asked with no budget and the first `k` of what it returns are the top k.
 */
import type { Brain } from "./brain.js";
import { recallFromBrain } from "./brain-index.js";
import type { FleetMemoryConfig } from "./config.js";
import { chunkIdHead } from "./ingest/brain-chunks.js";
import type { EmbedFn } from "./lexical.js";
import { canonicalChunkId } from "./recall-note.js";

/** The audit's k: a seat's prompt carries about this many recall lines, so it is what "found" means. */
export const DEFAULT_RECALL_K = 8;

/**
 * The seat a golden is ranked for when it names none: a name no seat has, so the ranker sees the
 * shared view (`memory/`, `decisions/`, `docs/`) and no seat's private notes.
 */
export const RETRIEVAL_EVAL_SEAT = "retrieval-eval";

/** One golden as the evaluator reads it; `improve/golden-store.ts`'s `RetrievalGolden` satisfies it. */
export interface RetrievalQuery {
  readonly id: string;
  readonly query: string;
  readonly expected_chunk_ids: readonly string[];
  readonly expected_doc?: { readonly slug: string; readonly page?: number };
  readonly seat?: string;
}

export interface RankedChunk {
  readonly id: string;
  readonly path: string;
  readonly page?: number;
  readonly score: number;
}

/** What a ranker is to the evaluator: a query and a seat in, chunks in rank order out. */
export type RetrievalRanker = (query: string, seat: string) => Promise<readonly RankedChunk[]>;

export interface RetrievalQueryResult {
  readonly id: string;
  readonly query: string;
  readonly expected: readonly string[];
  /** The top k the ranker returned, in order. */
  readonly ranked: readonly string[];
  readonly hit: boolean;
  /** 1-based position of the first expected chunk in the ranking, or null when it is not in the top k. */
  readonly rank: number | null;
}

export interface RetrievalEvalResult {
  readonly k: number;
  readonly queries: number;
  readonly hits: number;
  /** `hits / queries`; 0 when there are no queries, which `queries` says. */
  readonly recallAtK: number;
  readonly perQuery: readonly RetrievalQueryResult[];
}

export interface BrainRankerOptions {
  readonly brain: Brain;
  readonly embed?: EmbedFn;
  readonly config?: FleetMemoryConfig;
}

/** The shipped ranker: `recallFromBrain` with no budget cut, so the order is the whole related set. */
export function brainRanker(options: BrainRankerOptions): RetrievalRanker {
  return async (query, seat) => {
    const result = await recallFromBrain({
      profileDir: options.brain.profileDir,
      brain: options.brain,
      seat,
      objective: query,
      budgetChars: Number.MAX_SAFE_INTEGER,
      ...(options.config === undefined ? {} : { config: options.config }),
      ...(options.embed === undefined ? {} : { embed: options.embed }),
    });
    return result.items.map((item) => ({ id: item.id, path: item.path, ...(item.page === undefined ? {} : { page: item.page }), score: item.score }));
  };
}

export interface EvaluateRetrievalOptions extends Omit<BrainRankerOptions, "brain"> {
  readonly k?: number;
  /** The ranker under test. Omitted, the shipped one over `brain`. */
  readonly rank?: RetrievalRanker;
}

function matches(golden: RetrievalQuery, chunk: RankedChunk, expected: ReadonlySet<string>): boolean {
  if (expected.has(chunk.id)) return true;
  const doc = golden.expected_doc;
  if (doc === undefined) return false;
  return chunkIdHead(chunk.path) === doc.slug && (doc.page === undefined || chunk.page === doc.page);
}

/** recall@k of `goldens` under the ranker, deterministic for a given brain, golden set and embedder. */
export async function evaluateRetrieval(brain: Brain, goldens: readonly RetrievalQuery[], options: EvaluateRetrievalOptions = {}): Promise<RetrievalEvalResult> {
  const k = Math.max(1, Math.trunc(options.k ?? DEFAULT_RECALL_K));
  const rank = options.rank ?? brainRanker({ brain, ...(options.embed === undefined ? {} : { embed: options.embed }), ...(options.config === undefined ? {} : { config: options.config }) });
  const perQuery: RetrievalQueryResult[] = [];
  for (const golden of goldens) {
    const expected = new Set(golden.expected_chunk_ids.map((id) => canonicalChunkId(id) ?? id));
    const top = (await rank(golden.query, golden.seat ?? RETRIEVAL_EVAL_SEAT)).slice(0, k);
    const position = top.findIndex((chunk) => matches(golden, chunk, expected));
    perQuery.push({
      id: golden.id,
      query: golden.query,
      expected: [...expected],
      ranked: top.map((chunk) => chunk.id),
      hit: position >= 0,
      rank: position >= 0 ? position + 1 : null,
    });
  }
  const hits = perQuery.filter((q) => q.hit).length;
  return { k, queries: perQuery.length, hits, recallAtK: perQuery.length === 0 ? 0 : hits / perQuery.length, perQuery };
}
