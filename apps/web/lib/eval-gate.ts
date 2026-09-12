/**
 * Eval Gate — Phase 1 of the Trent self-improvement loop.
 *
 * Wraps runEvalSuite in a mechanical promotion rule: a self-generated candidate
 * (skill draft or evolved prompt) is promoted to live only if its score ≥ the
 * baseline AND it introduces no new failure-cluster category. This is the safety
 * interlock that keeps self-improvement provably non-regressing.
 *
 * Callers are responsible for moving artifacts from quarantine to live and
 * writing the audit-log entry after a `promoted: true` decision.
 *
 * See docs/superpowers/plans/2026-06-02-self-improvement-loop-plan.md Phase 1.
 */

import { runEvalSuite, type EvalSuiteInput, type EvalSuiteResult } from "@/lib/eval-harness";

export type EvalGateCandidate = {
  id: string;
  type: "skill" | "prompt";
  version: string;
};

export type EvalGateBaseline = {
  /** 0–1 score of the current production version on this suite. */
  score: number;
  /** Failure-cluster tags the current version already produces. New keys in the
   *  candidate result trigger a block even if overall delta ≥ 0. */
  failureClusters: Record<string, number>;
};

export type EvalGateDecision = {
  promoted: boolean;
  score: number;
  /** Signed delta vs baseline.score. */
  delta: number;
  blockedBy?: "regression" | "new_failure_cluster" | "no_improvement";
  result: EvalSuiteResult;
};

export type PromoteOptions = {
  /**
   * Slice 2: when true, the candidate must STRICTLY beat the baseline
   * (delta > 0) — a tie is not enough. Apply this to the *targeted* skill metric
   * so a candidate only promotes when it measurably improves the thing it
   * changed. Default (false) keeps the original ≥ rule (tie allowed) used for the
   * full frozen suite.
   */
  requireStrictImprovement?: boolean;
};

/**
 * Returns true when the candidate's failure clusters contain a key not present
 * in the baseline — a regression in a previously clean category.
 */
export function hasNewFailureCluster(
  current: Record<string, number>,
  baseline: Record<string, number>,
): boolean {
  return Object.keys(current).some((tag) => !(tag in baseline));
}

/**
 * Run `frozenSuite` against `candidate` and decide whether to promote.
 *
 * Promotion requires:
 *   1. delta (score − baseline.score) ≥ 0
 *   2. No new failure-cluster category appeared in the result
 *
 * A tie on score is allowed; any regression is blocked.
 */
export async function promoteCandidate(
  candidate: EvalGateCandidate,
  frozenSuite: Omit<EvalSuiteInput, "subjectId" | "previousScore">,
  baseline: EvalGateBaseline,
  options?: PromoteOptions,
): Promise<EvalGateDecision> {
  const result = await runEvalSuite({
    ...frozenSuite,
    subjectId: candidate.id,
    previousScore: baseline.score,
  });

  const delta = result.delta ?? result.score - baseline.score;

  if (delta < 0) {
    return { promoted: false, score: result.score, delta, blockedBy: "regression", result };
  }

  if (options?.requireStrictImprovement && delta === 0) {
    return { promoted: false, score: result.score, delta, blockedBy: "no_improvement", result };
  }

  if (hasNewFailureCluster(result.failureClusters, baseline.failureClusters)) {
    return { promoted: false, score: result.score, delta, blockedBy: "new_failure_cluster", result };
  }

  return { promoted: true, score: result.score, delta, result };
}
