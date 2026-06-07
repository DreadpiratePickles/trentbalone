/**
 * LLM Judge Grader — Slice 2 of the autoresearch loop.
 *
 * A skill's `evals.json` assertions are natural-language rubrics. Slice 1 mapped
 * them to `llm_rubric` graders that the eval-harness scored a flat 0.75
 * ("pending") — honest, but never a real pass/fail. This module turns those
 * rubrics into REAL scores by pre-judging each assertion against the candidate's
 * (live) output and attaching the verdict to the grader, which the harness then
 * honors synchronously.
 *
 * Seam discipline: the judge itself is INJECTED (`JudgeFn`). This module is pure
 * — it imports no AI client. The real OpenAI-backed judge lives at the edge in
 * `llm-judge-openai.ts`; unit tests pass a deterministic stub.
 */

import type { EvalGrader } from "@/lib/eval-harness";
import type { ActualsProvider, FixtureActual } from "@/lib/self-improvement/actuals-provider";
import { skillFixtureId, type SkillEval, type SkillEvalsJson } from "@/lib/self-improvement/frozen-suite";

/** The judge's decision for one assertion against one output. */
export type JudgeVerdict = { pass: boolean; score?: number; reason?: string };

/** Everything the judge needs to rule on a single assertion. */
export type JudgeInput = {
  /** The natural-language assertion / rubric being checked. */
  rubric: string;
  /** The fixture prompt/input (for context). */
  input?: unknown;
  /** The golden/expected output, when the eval defines one. */
  goldenOutput?: unknown;
  /** The agent's actual output to grade. */
  actual: FixtureActual;
};

/** Seam: scores one assertion. Real impl in `llm-judge-openai.ts`; stub in tests. */
export type JudgeFn = (input: JudgeInput) => Promise<JudgeVerdict>;

/** Default rubric used when an eval declares no assertions. */
export const DEFAULT_RUBRIC = "Response addresses the prompt.";

/**
 * Judge a fixture's assertions into concrete `llm_rubric` graders, each carrying
 * the judge's verdict. With no assertions, a single default-rubric grader is
 * produced so every fixture is still scored.
 */
export async function judgeAssertions(
  assertions: readonly string[],
  ctx: { input?: unknown; goldenOutput?: unknown; actual: FixtureActual },
  judge: JudgeFn,
): Promise<EvalGrader[]> {
  const rubrics = assertions.length === 0 ? [DEFAULT_RUBRIC] : [...assertions];
  const graders: EvalGrader[] = [];
  for (const rubric of rubrics) {
    const verdict = await judge({
      rubric,
      input: ctx.input,
      goldenOutput: ctx.goldenOutput,
      actual: ctx.actual,
    });
    graders.push({ type: "llm_rubric", weight: 1, rubric, verdict });
  }
  return graders;
}

/**
 * Pre-judge every eval in a skill against its (live) actual and return a
 * synchronous `gradersFor(ev)` the frozen suite consumes. Run this AFTER priming
 * a `LiveActualsProvider` so the judge sees fresh candidate output.
 */
export async function buildJudgedGradersFor(
  skill: SkillEvalsJson,
  actuals: ActualsProvider,
  judge: JudgeFn,
): Promise<(ev: SkillEval) => EvalGrader[]> {
  const byEvalId = new Map<string | number, EvalGrader[]>();
  for (const ev of skill.evals) {
    const actual = actuals.get(skillFixtureId(skill.skill_name, ev.id)) ?? {};
    const graders = await judgeAssertions(
      ev.assertions ?? [],
      { input: ev.prompt, goldenOutput: ev.expected_output, actual },
      judge,
    );
    byEvalId.set(ev.id, graders);
  }
  return (ev: SkillEval) => byEvalId.get(ev.id) ?? [];
}
