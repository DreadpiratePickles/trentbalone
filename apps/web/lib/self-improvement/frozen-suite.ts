/**
 * Frozen Suite — turns a skill's `evals/evals.json` into the ONE objective
 * metric the autoresearch loop optimizes against.
 *
 * "Frozen" means pinned: a candidate is always scored against the same snapshot
 * the baseline was measured on, so a delta is meaningful. The suite is assembled
 * from the per-skill `evals.json` (prompt / expected_output / assertions) that
 * already ship under `.agents/skills/<name>/evals/`, scored by the existing
 * `eval-harness` graders.
 *
 * Honest limitation (Slice 1): an `evals.json` assertion is a natural-language
 * rubric. Without a live agent run + LLM judge we cannot mechanically grade most
 * assertions, so the default mapping is `llm_rubric` (scored "pending"). The
 * live-execution slice adds the judge and real per-assertion grading. Callers
 * (and tests) may supply `gradersFor` to attach deterministic mechanical graders.
 */

import { createHash } from "node:crypto";
import type { EvalFixture, EvalGrader, EvalSuiteInput } from "@/lib/eval-harness";
import type { ActualsProvider } from "@/lib/self-improvement/actuals-provider";

/** Shape of a `.agents/skills/<name>/evals/evals.json` file. */
export type SkillEval = {
  id: number | string;
  prompt: string;
  expected_output?: string;
  assertions?: string[];
  files?: unknown[];
};

export type SkillEvalsJson = {
  skill_name: string;
  evals: SkillEval[];
};

/** Stable fixture id for a skill eval — used to look up recorded actuals. */
export function skillFixtureId(skillName: string, evalId: number | string): string {
  return `${skillName}:${evalId}`;
}

/**
 * Default grader mapping: each natural-language assertion becomes an
 * `llm_rubric` grader. Until the live-execution slice wires a judge these score
 * as "pending" (0.75) — deterministic, but not a real pass/fail. Override via
 * `buildSkillEvalSuite`'s `gradersFor` for mechanical (`contains`/`tool_call`)
 * grading.
 */
export function assertionsToGraders(assertions: readonly string[]): EvalGrader[] {
  if (assertions.length === 0) {
    return [{ type: "llm_rubric", weight: 1, rubric: "Response addresses the prompt." }];
  }
  return assertions.map((rubric) => ({ type: "llm_rubric", weight: 1, rubric }));
}

/** A version hash pinning the frozen suite so deltas stay comparable. */
export function frozenSuiteVersion(skill: SkillEvalsJson): string {
  return createHash("sha256")
    .update(JSON.stringify({ name: skill.skill_name, evals: skill.evals }))
    .digest("hex")
    .slice(0, 16);
}

export type BuildSkillEvalSuiteInput = {
  skill: SkillEvalsJson;
  actuals: ActualsProvider;
  /** Optional override for per-eval graders (tests / recorded mechanical graders). */
  gradersFor?: (ev: SkillEval) => EvalGrader[];
};

/**
 * Build the frozen `EvalSuiteInput` for a skill, minus the `subjectId` /
 * `previousScore` fields that the Eval Gate fills in per candidate. The returned
 * value is the exact shape `promoteCandidate(frozenSuite, …)` expects.
 */
export function buildSkillEvalSuite(
  input: BuildSkillEvalSuiteInput,
): Omit<EvalSuiteInput, "subjectId" | "previousScore"> {
  const { skill, actuals, gradersFor } = input;
  const fixtures: EvalFixture[] = skill.evals.map((ev) => {
    const id = skillFixtureId(skill.skill_name, ev.id);
    const actual = actuals.get(id) ?? {};
    return {
      id,
      rubricId: skill.skill_name,
      input: ev.prompt,
      goldenOutput: ev.expected_output,
      actual,
      graders: gradersFor ? gradersFor(ev) : assertionsToGraders(ev.assertions ?? []),
    };
  });

  return {
    subjectType: "plug",
    version: frozenSuiteVersion(skill),
    fixtures,
  };
}
