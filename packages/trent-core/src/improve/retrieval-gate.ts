/**
 * [W3] The `retrieval_recall` grader: recall@8 over the promoted retrieval goldens, held to a floor.
 *
 * Deterministic, so it runs with the other deterministic graders — FIRST, and a breach ends the
 * gate before a model is called (principle 12: nothing expensive does bulk work, and no LLM judges
 * retrieval; ids in, ids out, a number). The evaluator is injected: the sweep binds it to the
 * profile's brain and goldens (`fleet-memory/retrieval-eval.ts`), the gate's own test binds it to
 * a fixture brain and a ranker patched to return the reverse order.
 *
 * What the gate reads back is the whole report, so a refusal names the metric, the number, the
 * floor and the queries that missed — a human sees which golden the ranker lost, not "failed".
 * A set with no goldens is NOT measured and NOT a pass: it is reported as unmeasured and does not
 * block, because an absent exam is not evidence either way.
 */

import type { RetrievalEvalResult } from "../fleet-memory/retrieval-eval.js";
import { RETRIEVAL_GATE_DEFAULTS } from "./retrieval-config-schema.js";

/** The name the metric goes by in a verdict's `failureClusters`, `blockedBy` and the sweep report. */
export const RETRIEVAL_RECALL_METRIC = "retrieval_recall";
export const DEFAULT_RETRIEVAL_MIN_RECALL = RETRIEVAL_GATE_DEFAULTS.min_recall;

export interface RetrievalGateInput {
  /** recall@k over the promoted goldens under the ranker in force. Bound by the caller. */
  readonly evaluate: () => Promise<RetrievalEvalResult>;
  /** `retrieval.min_recall`. */
  readonly minRecall?: number;
}

export interface RetrievalMiss {
  readonly id: string;
  readonly query: string;
  readonly expected: readonly string[];
  /** The top k the ranker returned instead, in order. */
  readonly ranked: readonly string[];
}

export interface RetrievalGateReport {
  readonly metric: typeof RETRIEVAL_RECALL_METRIC;
  /** False when there were no goldens to measure; `passed` is then false too, and the gate does not block. */
  readonly measured: boolean;
  readonly passed: boolean;
  readonly recallAtK: number;
  readonly k: number;
  readonly queries: number;
  readonly hits: number;
  readonly minRecall: number;
  readonly misses: readonly RetrievalMiss[];
}

export async function gradeRetrievalRecall(input: RetrievalGateInput): Promise<RetrievalGateReport> {
  const minRecall = input.minRecall ?? DEFAULT_RETRIEVAL_MIN_RECALL;
  const result = await input.evaluate();
  const measured = result.queries > 0;
  return {
    metric: RETRIEVAL_RECALL_METRIC,
    measured,
    passed: measured && result.recallAtK >= minRecall,
    recallAtK: result.recallAtK,
    k: result.k,
    queries: result.queries,
    hits: result.hits,
    minRecall,
    misses: result.perQuery.filter((q) => !q.hit).map((q) => ({ id: q.id, query: q.query, expected: q.expected, ranked: q.ranked })),
  };
}

/** True when the report is a measured breach: the one case the gate blocks on. */
export function retrievalBreached(report: RetrievalGateReport): boolean {
  return report.measured && !report.passed;
}

/** `retrieval_recall:0.8<0.9`: the metric with its number and the floor, for a failure tag. */
export function retrievalFailureTag(report: RetrievalGateReport): string {
  return `${RETRIEVAL_RECALL_METRIC}:${String(report.recallAtK)}<${String(report.minRecall)}`;
}
