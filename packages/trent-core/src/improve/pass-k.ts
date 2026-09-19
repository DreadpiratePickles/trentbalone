/**
 * [D0] gate 3 — pass^k (design review section 6, item 6; CS329A G12).
 *
 * One draw per fixture is a coin flip dressed as a measurement: a candidate that passes once and
 * fails once looks exactly like a candidate that passes always. A fixture counts as passed here
 * only if it passes k CONSECUTIVE trials, default 3 (`improve.pass_k`).
 *
 * Isolation is the other half of the rule. Each trial runs the whole suite again through the
 * runner with its own `trial` number and NO gate cache, so a judge verdict memoised on trial 1
 * can never be handed to trial 3 and a runner that keys state off the trial number can reset
 * between them. The merge is pessimistic on purpose: a fixture's score is its worst trial, its
 * failure tags are the union of every trial's, and the cost is the sum — pass^k costs k times a
 * single draw and the meter sees all of it.
 */

import { scoreUnder } from "./gate-score.js";
import type { ActualsRunner, GateFixtureVerdict, GateVerdict, JudgeFn } from "./gate-types.js";
import type { GateCache } from "./gate-cache.js";
import type { FrozenSuite } from "./suites.js";

/** Trials a fixture must pass in a row. Three is the floor the research settles on. */
export const DEFAULT_PASS_K = 3;

export interface PassKInput {
  readonly suite: FrozenSuite;
  readonly systemPrompt: string;
  readonly actuals: ActualsRunner;
  readonly judge: JudgeFn | undefined;
  /** Used only at k = 1; with more than one trial the trials share nothing. */
  readonly cache: GateCache | undefined;
  readonly candidateId: string;
  readonly previousScore: number | undefined;
  readonly passK?: number;
  readonly judgeAdvisory?: boolean;
  readonly temperature?: number;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function mergeFixtures(trials: readonly GateVerdict[]): GateFixtureVerdict[] {
  const merged = new Map<string, GateFixtureVerdict>();
  for (const trial of trials) {
    for (const fixture of trial.fixtures) {
      const seen = merged.get(fixture.id);
      if (!seen) {
        merged.set(fixture.id, { ...fixture, failureTags: [...fixture.failureTags] });
        continue;
      }
      merged.set(fixture.id, {
        id: fixture.id,
        score: Math.min(seen.score, fixture.score),
        passed: seen.passed && fixture.passed,
        failureTags: [...new Set([...seen.failureTags, ...fixture.failureTags])],
        costCents: seen.costCents + fixture.costCents,
      });
    }
  }
  return [...merged.values()];
}

function clustersOf(fixtures: readonly GateFixtureVerdict[]): Record<string, number> {
  const clusters: Record<string, number> = {};
  for (const tag of fixtures.flatMap((f) => f.failureTags)) clusters[tag] = (clusters[tag] ?? 0) + 1;
  return clusters;
}

function sum(trials: readonly GateVerdict[], of: (v: GateVerdict) => number): number {
  return trials.reduce((total, trial) => total + of(trial), 0);
}

/**
 * Scores the suite k times and returns one verdict whose fixtures passed every trial. A trial
 * that short-circuits on a deterministic grader ends the run there: a candidate that fails a
 * mechanical check on any trial cannot pass k of them.
 */
export async function scoreUnderPassK(input: PassKInput): Promise<GateVerdict> {
  const k = Math.max(1, Math.trunc(input.passK ?? 1));
  const trials: GateVerdict[] = [];
  for (let trial = 1; trial <= k; trial += 1) {
    const verdict = await scoreUnder(
      input.suite,
      input.systemPrompt,
      input.actuals,
      input.judge,
      k === 1 ? input.cache : undefined,
      input.candidateId,
      input.previousScore,
      {
        trial,
        ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
        ...(input.judgeAdvisory === undefined ? {} : { judgeAdvisory: input.judgeAdvisory }),
      },
    );
    trials.push(verdict);
    if (verdict.stage === "deterministic") break;
  }
  const last = trials[trials.length - 1]!;
  if (k === 1) return { ...last, trials: 1 };
  if (last.stage === "deterministic") {
    return { ...last, trials: trials.length, actualsCalls: sum(trials, (t) => t.actualsCalls), judgeCalls: sum(trials, (t) => t.judgeCalls), costCents: sum(trials, (t) => t.costCents) };
  }
  const fixtures = mergeFixtures(trials);
  const score = fixtures.length === 0 ? last.score : round(fixtures.reduce((total, f) => total + f.score, 0) / fixtures.length);
  return {
    promoted: false,
    score,
    delta: input.previousScore === undefined ? 0 : round(score - input.previousScore),
    stage: "judge",
    actualsCalls: sum(trials, (t) => t.actualsCalls),
    judgeCalls: sum(trials, (t) => t.judgeCalls),
    pendingRubrics: Math.max(...trials.map((t) => t.pendingRubrics)),
    fixtures,
    failureClusters: clustersOf(fixtures),
    costCents: sum(trials, (t) => t.costCents),
    trials: trials.length,
  };
}
