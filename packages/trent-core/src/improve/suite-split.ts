/**
 * The ONE partition of every eval suite (task I.16, extended by [D0] gate 2; CS329A L4 @31:33
 * RLEF: public tests for iteration, private tests for the reward; L7 @36:21: the scorer must not
 * train on what it ranks).
 *
 * There is no second hold-out anywhere: the public/private split this file shipped IS the
 * optimise/holdout split, renamed for what each side decides.
 *
 *   optimise  what reflection may read and what the sweep reports as an agent's score
 *   holdout   never shown to a reflection, and the only side promotion is decided on
 *
 * The partition is deterministic per fixture: the first byte of sha256(fixture id) puts about
 * `improve.holdout_ratio` of the ids (default 30 percent) in the holdout, so the same suite
 * splits the same way on every machine and every sweep. A fixture's own `holdout` flag (set by
 * hand, or by the mechanical overlay's `holdout: [ids]`) overrides the hash.
 *
 * A candidate that lifts the optimise side and drops the holdout is blocked `holdout_regression`
 * by `gate.ts`, before the ordinary regression and cluster checks, so the reason a human reads is
 * the specific one.
 */

import { createHash } from "node:crypto";

import { buildReflectionPrompt } from "../gepa/index.js";
import type { TraceRecord } from "../traces/trace-store.js";
import type { GateBaseline, GatePartition, GateVerdict } from "./gate-types.js";
import type { FrozenFixture, FrozenSuite } from "./suites.js";

/** Share of fixtures the hash holds out when nothing says otherwise; `improve.holdout_ratio`. */
export const DEFAULT_HOLDOUT_RATIO = 0.3;

export function isHoldoutFixture(fixture: FrozenFixture, ratio: number = DEFAULT_HOLDOUT_RATIO): boolean {
  if (fixture.holdout !== undefined) return fixture.holdout;
  const byte = createHash("sha256").update(fixture.id, "utf8").digest()[0] ?? 0;
  return byte < Math.round(ratio * 256);
}

export interface SuiteSplit {
  optimise: FrozenFixture[];
  holdout: FrozenFixture[];
}

export function splitSuite(suite: FrozenSuite, ratio: number = DEFAULT_HOLDOUT_RATIO): SuiteSplit {
  const split: SuiteSplit = { optimise: [], holdout: [] };
  for (const fixture of suite.fixtures) (isHoldoutFixture(fixture, ratio) ? split.holdout : split.optimise).push(fixture);
  return split;
}

/** The suite reduced to one side of the partition, keeping its id and version. */
export function holdoutSuite(suite: FrozenSuite, ratio: number = DEFAULT_HOLDOUT_RATIO): FrozenSuite {
  return { ...suite, fixtures: splitSuite(suite, ratio).holdout };
}

/** Held-out fixture ids the baseline passed and this verdict failed. Empty without per-fixture baseline data. */
export function holdoutRegressions(suite: FrozenSuite, baseline: GateBaseline, verdict: GateVerdict, ratio: number = DEFAULT_HOLDOUT_RATIO): string[] {
  if (!baseline.fixtures) return [];
  const before = new Map(baseline.fixtures.map((f) => [f.id, f.passed] as const));
  const holdoutIds = new Set(splitSuite(suite, ratio).holdout.map((f) => f.id));
  return verdict.fixtures.filter((f) => holdoutIds.has(f.id) && before.get(f.id) === true && !f.passed).map((f) => f.id);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function meanOf(scores: readonly number[]): number | undefined {
  return scores.length === 0 ? undefined : round(scores.reduce((total, s) => total + s, 0) / scores.length);
}

/**
 * One side's score and its movement. The baseline side is measured from the baseline's per-fixture
 * scores when it has them; a baseline that predates them (or was built by hand) falls back to its
 * whole-suite score, which is conservative rather than absent.
 */
function partitionOf(ids: ReadonlySet<string>, baseline: GateBaseline, verdict: GateVerdict): GatePartition {
  const scores = verdict.fixtures.filter((f) => ids.has(f.id)).map((f) => f.score);
  const score = meanOf(scores) ?? verdict.score;
  const baselineScores = (baseline.fixtures ?? []).filter((f) => ids.has(f.id) && typeof f.score === "number").map((f) => f.score as number);
  const before = meanOf(baselineScores) ?? baseline.score;
  return { score, delta: round(score - before), fixtures: scores.length };
}

export interface PartitionMetrics {
  optimise: GatePartition;
  holdout: GatePartition & { regressions: string[] };
}

/**
 * Both sides of one verdict. An empty side is measured on the whole suite rather than skipped:
 * a suite too small to hold anything out still has to answer the promotion question, and the
 * `fixtures` count says which case a reader is looking at.
 */
export function partitionMetrics(suite: FrozenSuite, baseline: GateBaseline, verdict: GateVerdict, ratio: number = DEFAULT_HOLDOUT_RATIO): PartitionMetrics {
  const split = splitSuite(suite, ratio);
  const everyId = new Set(verdict.fixtures.map((f) => f.id));
  const optimiseIds = split.optimise.length === 0 ? everyId : new Set(split.optimise.map((f) => f.id));
  const holdoutIds = split.holdout.length === 0 ? everyId : new Set(split.holdout.map((f) => f.id));
  return {
    optimise: partitionOf(optimiseIds, baseline, verdict),
    holdout: { ...partitionOf(holdoutIds, baseline, verdict), regressions: holdoutRegressions(suite, baseline, verdict, ratio) },
  };
}

const RESPOND_MARKER = "\nRespond with JSON:";

/**
 * The reflection prompt with the baseline's failing OPTIMISE fixtures appended as a section, so
 * the reflection can see what the suite asks and where the current prompt falls short, and never
 * a held-out fixture's id or text. The lib's prompt is the app's; the section is inserted ahead of
 * its response instructions. The result is sent to a model and must never be logged.
 */
export function buildOptimiseReflectionPrompt(
  role: TraceRecord["agentRole"],
  currentPrompt: string,
  failingTraces: readonly TraceRecord[],
  suite: FrozenSuite | undefined,
  baseline: GateBaseline | undefined,
  ratio: number = DEFAULT_HOLDOUT_RATIO,
): string {
  const base = buildReflectionPrompt(role, currentPrompt, failingTraces);
  if (!suite || !baseline?.fixtures) return base;
  const failed = new Set(baseline.fixtures.filter((f) => !f.passed).map((f) => f.id));
  const lines = splitSuite(suite, ratio)
    .optimise.filter((f) => failed.has(f.id))
    .slice(0, 20)
    .map((f, i) => `Fixture ${i + 1} (${f.id}): ${f.prompt}`);
  if (lines.length === 0) return base;
  const section = ["", "Eval fixtures the current prompt fails (a held-out set is scored too, and is not shown):", ...lines, ""].join("\n");
  const at = base.lastIndexOf(RESPOND_MARKER);
  return at === -1 ? `${base}\n${section}` : `${base.slice(0, at)}${section}${base.slice(at)}`;
}
