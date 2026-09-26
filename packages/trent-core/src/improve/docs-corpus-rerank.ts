/**
 * [P2-13] The reranker measured on the docs corpus: a recording of what the model said, and its replay.
 *
 * A live rerank is one model call per question (`fleet-memory/rerank-llm.ts`). What the recall
 * CONSUMES of that call is the score it gave each pool candidate, so that is what a live run records
 * (`fixtures/docs-corpus/rerank-scores.json`), per question: the pool it was shown (chunk ids, in
 * order), every score the reply carried, the status, and the metered usage. The replay hands the
 * shipped `recallFromBrain` those scores through the same `BrainReranker` seam and applies the
 * no-answer threshold itself, so the threshold can be varied offline for free and the rest — the
 * pool, the picks-then-blend order, the abstention — is the shipped code running unchanged.
 *
 * A replay is only valid for the pool it was recorded on. A question whose pool differs (a different
 * first stage, a chunker change) is counted and answered `failed`, which the recall treats as "keep
 * the blend's order" — so a stale recording shows up as a coverage number, never as a silent score.
 */
import fs from "node:fs";
import { z } from "zod";

import { EXIT, TrentError } from "../errors/index.js";
import { pickRelevant, type BrainReranker, type RerankOutcome, type RerankScore, type RerankUsage } from "../fleet-memory/rerank.js";
import { textKey } from "./recorded-embedder.js";

export const RECORDED_RERANK_FILE = "rerank-scores.json";

const RecordedQuerySchema = z
  .object({
    status: z.enum(["ranked", "abstained", "refused", "failed"]),
    pool: z.array(z.string().min(1)),
    /** `[chunk id, score]` in the order the reply gave them. */
    scores: z.array(z.tuple([z.string().min(1), z.number().min(0).max(1)])),
    reason: z.string().optional(),
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    micro_cents: z.number().int().nonnegative(),
    estimated: z.boolean(),
  })
  .strict();

const RecordedRerankSchema = z
  .object({
    version: z.literal(1),
    model: z.string().min(1),
    /** The first-stage recording the pools were built from (`embeddings.json` or the task-typed one). */
    first_stage: z.string().min(1),
    captured_at: z.string().min(1),
    note: z.string(),
    /** Query text key (`textKey`) to what the model said about that question's pool. */
    queries: z.record(z.string().regex(/^[0-9a-f]{16}$/), RecordedQuerySchema),
  })
  .strict();

export type RecordedRerank = z.infer<typeof RecordedRerankSchema>;
export type RecordedRerankQuery = z.infer<typeof RecordedQuerySchema>;

export function readRecordedRerank(file: string): RecordedRerank {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch (cause) {
    throw new TrentError({ code: EXIT.CONFIG, operation: "improve.recorded_rerank", message: `cannot read ${file}`, target: file, cause });
  }
  return RecordedRerankSchema.parse(raw);
}

/** One question per line, so a re-recording diffs by question. */
export function writeRecordedRerank(file: string, table: RecordedRerank): void {
  const { queries, ...head } = RecordedRerankSchema.parse(table);
  const headLines = Object.entries(head).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
  const rows = Object.entries(queries).map(([key, row]) => `    ${JSON.stringify(key)}: ${JSON.stringify(row)}`);
  fs.writeFileSync(file, `{\n${headLines.join("\n")}\n  "queries": {\n${rows.join(",\n")}\n  }\n}\n`, "utf8");
}

/** What a live rerank produced, in the recording's shape. */
export function recordOutcome(pool: readonly string[], outcome: RerankOutcome): RecordedRerankQuery {
  const usage: RerankUsage | undefined = "usage" in outcome ? outcome.usage : undefined;
  const scores: readonly RerankScore[] = "scores" in outcome ? outcome.scores : [];
  return {
    status: outcome.status,
    pool: [...pool],
    scores: scores.map((s) => [s.id, s.score] as [string, number]),
    ...("reason" in outcome ? { reason: outcome.reason.slice(0, 300) } : {}),
    input_tokens: usage?.inputTokens ?? 0,
    output_tokens: usage?.outputTokens ?? 0,
    micro_cents: usage?.microCents ?? 0,
    estimated: usage?.estimated ?? false,
  };
}

/** Wraps a live reranker so every outcome is kept against its question, pool included. */
export function recordingReranker(inner: BrainReranker, sink: Map<string, RecordedRerankQuery>): BrainReranker {
  return async (request) => {
    const outcome = await inner(request);
    sink.set(textKey(request.query), recordOutcome(request.candidates.map((c) => c.id), outcome));
    return outcome;
  };
}

export interface ReplayRerankStats {
  readonly calls: number;
  /** Questions the recording holds nothing for. */
  readonly missing: number;
  /** Questions whose pool is not the pool the recording was made on. */
  readonly poolMismatches: number;
}

export interface ReplayReranker extends BrainReranker {
  stats(): ReplayRerankStats;
}

/**
 * The recorded scores through the shipped seam, at `minScore`. A recorded failure replays as one; a
 * recorded abstention or ranking is re-derived from the scores at THIS threshold.
 */
export function replayReranker(table: RecordedRerank, minScore: number): ReplayReranker {
  let calls = 0;
  let missing = 0;
  let poolMismatches = 0;
  const replay: BrainReranker = async (request) => {
    calls += 1;
    const row = table.queries[textKey(request.query)];
    if (row === undefined) {
      missing += 1;
      return { status: "failed", reason: "no recorded rerank for this question" };
    }
    const pool = request.candidates.map((c) => c.id);
    if (pool.length !== row.pool.length || pool.some((id, i) => id !== row.pool[i])) {
      poolMismatches += 1;
      return { status: "failed", reason: "the recorded pool is not this pool; re-record the rerank" };
    }
    const usage: RerankUsage = { model: table.model, provider: "google", inputTokens: row.input_tokens, outputTokens: row.output_tokens, microCents: row.micro_cents, estimated: row.estimated };
    if (row.status === "failed" || row.status === "refused") return { status: "failed", reason: row.reason ?? row.status, usage };
    const scores = row.scores.map(([id, score]) => ({ id, score }));
    const picks = pickRelevant(scores, minScore, pool);
    return picks.length === 0 ? { status: "abstained", scores, usage } : { status: "ranked", picks, scores, usage };
  };
  return Object.assign(replay, { stats: (): ReplayRerankStats => ({ calls, missing, poolMismatches }) });
}
