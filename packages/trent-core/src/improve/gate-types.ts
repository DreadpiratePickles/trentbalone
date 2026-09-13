/**
 * The executing gate's contract: what a model runner and a judge look like to it, what a
 * candidate and a baseline are, and what a verdict carries. Kept apart from the logic so
 * `gate.ts`, `gate-score.ts` and `gate-redraw.ts` share one vocabulary without a cycle.
 */

import type { GateCache } from "./gate-cache.js";
import type { FrozenSuite } from "./suites.js";

export interface ActualsInput {
  readonly systemPrompt: string;
  readonly prompt: string;
  readonly fixtureId: string;
  /** Sampling temperature for this draw. Omitted means the runner's default (0 for the gateway). */
  readonly temperature?: number;
  /** 1 for the deciding draw, 2 for the reliability re-draw (task I.12). */
  readonly draw?: number;
}

export interface ActualsOutput {
  readonly text: string;
  readonly toolCalls?: readonly string[];
  /** Observable state for `state_check` graders, when the runner can report one. */
  readonly state?: Record<string, unknown>;
  /** Integer cents. */
  readonly costCents: number;
}

/** Runs one fixture prompt under a system prompt and returns what the model actually produced. */
export type ActualsRunner = (input: ActualsInput) => Promise<ActualsOutput>;

export interface JudgeInput {
  readonly rubric: string;
  readonly prompt: string;
  readonly goldenOutput?: string;
  readonly actual: { readonly text: string; readonly toolCalls: readonly string[] };
}

/**
 * A judge verdict. `evidence` is a substring the judge claims appears in the output; the gate
 * checks that it really does BEFORE accepting a pass (task I.7, deterministic meta-verification).
 * `costCents` is what the judge call cost, integer cents; omitted means the caller had no usage.
 */
export type JudgeVerdict = { pass: boolean; score?: number; reason?: string; evidence?: string; costCents?: number };
export type JudgeFn = (input: JudgeInput) => Promise<JudgeVerdict>;

export interface GateCandidate {
  readonly id: string;
  readonly kind: "skill" | "prompt";
  readonly content: string;
}

export interface BaselineFixture {
  readonly id: string;
  readonly passed: boolean;
}

export interface GateBaseline {
  readonly score: number;
  readonly failureClusters: Record<string, number>;
  /** Per-fixture pass/fail of the baseline, so a candidate's flips can be found (task I.12). */
  readonly fixtures?: readonly BaselineFixture[];
}

export interface GateFixtureVerdict {
  id: string;
  score: number;
  passed: boolean;
  failureTags: string[];
  costCents: number;
}

export type GateBlockReason =
  | "deterministic_failure"
  | "regression"
  | "new_failure_cluster"
  | "unverified"
  | "unstable"
  | "budget_exhausted";

/** What the reliability re-draw did: which fixtures it re-ran, what it cost, which did not hold. */
export interface RedrawReport {
  fixtures: string[];
  actualsCalls: number;
  judgeCalls: number;
  unstable: string[];
}

export interface GateVerdict {
  promoted: boolean;
  score: number;
  delta: number;
  blockedBy?: GateBlockReason;
  /** Which stage decided: the deterministic short-circuit, or the full run including the judge. */
  stage: "deterministic" | "judge";
  /** Model calls this gate run actually made, re-draw included (cache hits are not calls). */
  actualsCalls: number;
  judgeCalls: number;
  /** Rubric graders left pending because no judge ran: the verdict is unverified while > 0. */
  pendingRubrics: number;
  fixtures: GateFixtureVerdict[];
  failureClusters: Record<string, number>;
  /** Integer cents spent executing the suite AND judging it, re-draw included. */
  costCents: number;
  /** Present when a second draw ran on flipped fixtures (task I.12). */
  redraw?: RedrawReport;
}

export interface ExecuteGateInput {
  readonly candidate: GateCandidate;
  readonly seatPrompt: string;
  readonly suite: FrozenSuite;
  readonly baseline: GateBaseline;
  readonly actuals: ActualsRunner;
  /** Omit to leave rubric graders pending (0.75, tagged `llm_judge_pending`); no model is called and the verdict is unverified. */
  readonly judge?: JudgeFn;
  /** Memoised judge verdicts. Omit for no memo (every rubric is judged). */
  readonly cache?: GateCache;
  /** Temperature of the reliability re-draw. Default 0.7. */
  readonly redrawTemperature?: number;
}

export interface MeasuredBaseline extends GateBaseline {
  fixtures: BaselineFixture[];
  costCents: number;
  actualsCalls: number;
  judgeCalls: number;
}
