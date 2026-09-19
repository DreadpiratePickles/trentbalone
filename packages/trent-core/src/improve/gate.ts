/**
 * Item 3 of the loop — an eval gate that EXECUTES the candidate.
 *
 * The app's `promoteCandidate` scores pre-baked actuals, so its score is independent of the
 * candidate: `gepa.ts:264` grades a prompt nobody ran. This gate runs every fixture of the frozen
 * suite WITH the candidate — a skill injected into the seat prompt, or a GEPA proposal swapped in
 * for it — collects the real outputs, then grades them with the app's weighted graders.
 *
 * Order is the safety property: deterministic graders (`contains`, `tool_call`, `state_check`) run
 * FIRST and short-circuit; the LLM judge runs only when they all pass (`gate-score.ts`). Every
 * verdict is returned so the caller can store it on the iteration row.
 *
 * Rules from the CS329A analysis (sections 3.1-3.5):
 *   - a candidate nobody verified cannot be promoted (`unverified`);
 *   - a judge verdict is memoised by (fixture, rubric, sha256(output)) through `GateCache`;
 *   - a judge that cites evidence not in the output is not believed (`judge_unverified`);
 *   - rubric failures are tagged per fixture so the frontier has a real profile;
 *   - a promotion must survive a second draw on the fixtures it flipped (`gate-redraw.ts`);
 *   - a candidate whose fixture run loops on one tool cannot be promoted (`repetitive_loop`);
 *   - a candidate that regresses a held-out fixture the reflection never saw cannot be promoted
 *     (`holdout_regression`, `suite-split.ts`).
 *
 * Plus the [D0] gates: every fixture is run `passK` times and passes only if it passed them all
 * (`pass-k.ts`); promotion is decided on the HOLDOUT side of the partition, never on the side
 * reflection optimises; and a judge below its calibration floor is advisory, so it cannot be the
 * reason anything passes.
 *
 * Model access is injected (`ActualsRunner`, `JudgeFn`), so the whole gate is testable offline.
 * `createGatewayActuals` binds it to the real model gateway; `judge.ts` binds the judge. Every
 * cost is integer cents from the gateway's own usage; judge cost counts too.
 */

import type { GatewayMessage, ModelGateway } from "../model-gateway/types.js";
import { redrawFlipped } from "./gate-redraw.js";
import { JUDGE_ADVISORY_TAG } from "./gate-score.js";
import type { ActualsRunner, ExecuteGateInput, GateCandidate, GateVerdict, MeasuredBaseline } from "./gate-types.js";
import { scoreUnderPassK } from "./pass-k.js";
import { isRepetitiveLoopTag } from "./repetitive-loop.js";
import { partitionMetrics } from "./suite-split.js";

export type * from "./gate-types.js";

/** A skill is injected ahead of the seat prompt (as the app's skill prelude does); a prompt replaces it. */
export function composeSystemPrompt(seatPrompt: string, candidate: GateCandidate | undefined): string {
  if (!candidate) return seatPrompt;
  if (candidate.kind === "prompt") return candidate.content;
  return `${seatPrompt}\n\n## Company skill (candidate)\n${candidate.content}`;
}

/**
 * [D0] gate 6: `judge_advisory` is excluded. It says the judge is below its calibration floor,
 * which is true of every candidate measured while that holds, so counting it as a new failure
 * cluster would hide the real reason (`unverified`) behind a symptom.
 */
export function hasNewFailureCluster(current: Record<string, number>, baseline: Record<string, number>): boolean {
  return Object.keys(current).some((tag) => tag !== JUDGE_ADVISORY_TAG && !(tag in baseline));
}

/** Run the frozen suite WITH the candidate and decide. Never throws on a grader outcome. */
export async function executeGate(input: ExecuteGateInput): Promise<GateVerdict> {
  const systemPrompt = composeSystemPrompt(input.seatPrompt, input.candidate);
  const scored = await scoreUnderPassK({
    suite: input.suite,
    systemPrompt,
    actuals: input.actuals,
    judge: input.judge,
    cache: input.cache,
    candidateId: input.candidate.id,
    previousScore: input.baseline.score,
    ...(input.passK === undefined ? {} : { passK: input.passK }),
    ...(input.judgeAdvisory === undefined ? {} : { judgeAdvisory: input.judgeAdvisory }),
  });
  if (scored.stage === "deterministic") return scored;
  const partitions = partitionMetrics(input.suite, input.baseline, scored, input.holdoutRatio);
  const verdict: GateVerdict = { ...scored, optimise: partitions.optimise, holdout: partitions.holdout };
  // The two most specific reasons first, so a human reads the failure mode, not its symptom.
  if (verdict.fixtures.some((f) => f.failureTags.some(isRepetitiveLoopTag))) return { ...verdict, blockedBy: "repetitive_loop" };
  // [D0] gate 2: promotion is decided on the holdout. A candidate may lift everything the
  // reflection could see and still be refused here, which is the whole point of holding it back.
  if (partitions.holdout.regressions.length > 0 || partitions.holdout.delta < 0) return { ...verdict, blockedBy: "holdout_regression" };
  if (verdict.delta < 0) return { ...verdict, blockedBy: "regression" };
  if (hasNewFailureCluster(verdict.failureClusters, input.baseline.failureClusters)) return { ...verdict, blockedBy: "new_failure_cluster" };
  // A rubric nobody judged scored 0.75 on both sides; that is not a measurement, so it cannot promote.
  if (verdict.pendingRubrics > 0) return { ...verdict, blockedBy: "unverified" };
  // Would promote: the fixtures this candidate flipped must hold on a second, warmer draw.
  const settled = await redrawFlipped({
    suite: input.suite,
    systemPrompt,
    baseline: input.baseline,
    verdict,
    actuals: input.actuals,
    judge: input.judge,
    cache: input.cache,
    candidateId: input.candidate.id,
    ...(input.redrawTemperature === undefined ? {} : { temperature: input.redrawTemperature }),
  });
  return settled.blockedBy === undefined ? { ...settled, promoted: true } : settled;
}

/** Measure the CURRENT artifact the same way, so the baseline is executed, not assumed. */
export async function measureBaseline(input: Omit<ExecuteGateInput, "candidate" | "baseline">): Promise<MeasuredBaseline> {
  const verdict = await scoreUnderPassK({
    suite: input.suite,
    systemPrompt: input.seatPrompt,
    actuals: input.actuals,
    judge: input.judge,
    cache: input.cache,
    candidateId: "baseline",
    previousScore: undefined,
    ...(input.passK === undefined ? {} : { passK: input.passK }),
    ...(input.judgeAdvisory === undefined ? {} : { judgeAdvisory: input.judgeAdvisory }),
  });
  return {
    score: verdict.score,
    failureClusters: verdict.failureClusters,
    fixtures: verdict.fixtures.map((f) => ({ id: f.id, passed: f.passed, score: f.score })),
    costCents: verdict.costCents,
    actualsCalls: verdict.actualsCalls,
    judgeCalls: verdict.judgeCalls,
  };
}

/** Pulls `name:action` tool calls out of a JSON tool-use turn; plain prose yields none. */
export function extractToolCalls(text: string): string[] {
  try {
    const parsed = JSON.parse(text) as { toolCall?: { name?: string; action?: string } | null; toolCalls?: Array<{ name?: string; action?: string }> };
    const calls = [...(parsed.toolCall ? [parsed.toolCall] : []), ...(parsed.toolCalls ?? [])];
    return calls.filter((c) => typeof c.name === "string").map((c) => (c.action ? `${c.name}:${c.action}` : String(c.name)));
  } catch {
    return [];
  }
}

export interface GatewayActualsOptions {
  readonly maxTokens?: number;
  /** Default temperature for the deciding draw; a draw that names its own temperature wins. */
  readonly temperature?: number;
}

/**
 * Binds the gate to the real model gateway: system + user messages in, text and tool calls out,
 * integer cents from the gateway's own estimate. The prompt body is never logged here.
 */
export function createGatewayActuals(gateway: ModelGateway, options: GatewayActualsOptions = {}): ActualsRunner {
  return async ({ systemPrompt, prompt, temperature }) => {
    const messages: GatewayMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt },
    ];
    const completion = await gateway.complete({
      messages,
      role: "executor",
      maxTokens: options.maxTokens ?? 1024,
      temperature: temperature ?? options.temperature ?? 0,
    });
    return { text: completion.text, toolCalls: extractToolCalls(completion.text), costCents: Math.trunc(completion.costCents) };
  };
}
