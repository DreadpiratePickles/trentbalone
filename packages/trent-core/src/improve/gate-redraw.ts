/**
 * Second-draw reliability (task I.12; CS329A L8 @20:48-21:59).
 *
 * One temperature-0 draw is a 50-percent-horizon measurement presented as a decision. After a
 * candidate would be promoted, ONLY the fixtures whose pass/fail flipped against the baseline are
 * run once more, at temperature 0.7, and the flip must hold: a fixture that passed on draw 1 and
 * fails on draw 2 (or the reverse) blocks the promotion with `unstable`. Fixtures that did not
 * flip are not re-run, so the cost is (flipped fixtures) x (1 + their assertions), all metered
 * through the same injected runner and judge.
 *
 * A baseline without per-fixture results (a hand-built one, or one cached before this existed)
 * cannot tell a flip from a hold, so no re-draw runs and the verdict says so with no `redraw`.
 */

import type { GateCache } from "./gate-cache.js";
import { scoreUnder } from "./gate-score.js";
import type { ActualsRunner, GateBaseline, GateVerdict, JudgeFn, RedrawReport } from "./gate-types.js";
import type { FrozenSuite } from "./suites.js";

export const DEFAULT_REDRAW_TEMPERATURE = 0.7;

export interface RedrawInput {
  readonly suite: FrozenSuite;
  readonly systemPrompt: string;
  readonly baseline: GateBaseline;
  readonly verdict: GateVerdict;
  readonly actuals: ActualsRunner;
  readonly judge: JudgeFn | undefined;
  readonly cache: GateCache | undefined;
  readonly candidateId: string;
  readonly temperature?: number;
}

/** The fixtures whose pass/fail differs between the baseline and this verdict. */
export function flippedFixtures(baseline: GateBaseline, verdict: GateVerdict): string[] {
  if (!baseline.fixtures) return [];
  const before = new Map(baseline.fixtures.map((f) => [f.id, f.passed] as const));
  return verdict.fixtures.filter((f) => before.has(f.id) && before.get(f.id) !== f.passed).map((f) => f.id);
}

/** Re-runs the flipped fixtures once and folds the cost and calls into the verdict. */
export async function redrawFlipped(input: RedrawInput): Promise<GateVerdict> {
  const flipped = flippedFixtures(input.baseline, input.verdict);
  if (flipped.length === 0) return input.verdict;

  const subset: FrozenSuite = { ...input.suite, fixtures: input.suite.fixtures.filter((f) => flipped.includes(f.id)) };
  const second = await scoreUnder(subset, input.systemPrompt, input.actuals, input.judge, input.cache, input.candidateId, undefined, {
    temperature: input.temperature ?? DEFAULT_REDRAW_TEMPERATURE,
    draw: 2,
  });
  const firstPassed = new Map(input.verdict.fixtures.map((f) => [f.id, f.passed] as const));
  const secondPassed = new Map(second.fixtures.map((f) => [f.id, f.passed] as const));
  // A deterministic short-circuit on the second draw grades only the mechanical fixtures; a flipped
  // fixture missing from it, or graded differently, did not hold.
  const unstable = flipped.filter((id) => secondPassed.get(id) !== firstPassed.get(id));
  const redraw: RedrawReport = { fixtures: flipped, actualsCalls: second.actualsCalls, judgeCalls: second.judgeCalls, unstable };
  const merged: GateVerdict = {
    ...input.verdict,
    actualsCalls: input.verdict.actualsCalls + second.actualsCalls,
    judgeCalls: input.verdict.judgeCalls + second.judgeCalls,
    costCents: input.verdict.costCents + second.costCents,
    redraw,
  };
  return unstable.length > 0 ? { ...merged, promoted: false, blockedBy: "unstable" } : merged;
}
