/**
 * Frozen suites: the fixed set of prompts and graders a candidate is executed against.
 *
 * "Frozen" means pinned — a candidate is always scored against the same fixtures the baseline
 * was measured on, so a delta is meaningful. Fixtures come from a skill's `evals/evals.json`
 * (the agentskills.io layout under `.agents/skills/<name>/evals/`), mapped the same way the app's
 * `frozen-suite.ts` maps them: every natural-language assertion becomes an `llm_rubric` grader.
 * An eval entry may also carry mechanical graders (`contains`, `required_tools`, `forbidden_tools`),
 * which run FIRST in the gate and short-circuit it.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { EvalGrader } from "../evals/index.js";

/** A grader as stored on a frozen fixture: never carries a pre-computed judge verdict. */
export type FrozenGrader = Exclude<EvalGrader, { type: "llm_rubric" }> | { type: "llm_rubric"; weight: number; rubric: string };

export interface FrozenFixture {
  id: string;
  prompt: string;
  goldenOutput?: string;
  graders: FrozenGrader[];
}

export interface FrozenSuite {
  id: string;
  version: string;
  fixtures: FrozenFixture[];
}

/** Resolves the frozen suite for an agent; undefined means "this agent cannot be gated yet". */
export type SuiteProvider = (agentId: string) => Promise<FrozenSuite | undefined> | FrozenSuite | undefined;

/** Shape of `evals/evals.json`, plus the optional mechanical fields this loop understands. */
export interface SkillEvalsJson {
  skill_name: string;
  evals: Array<{
    id: number | string;
    prompt: string;
    expected_output?: string;
    assertions?: string[];
    contains?: string[];
    required_tools?: string[];
    forbidden_tools?: string[];
  }>;
}

export function suiteVersion(skill: SkillEvalsJson): string {
  return createHash("sha256").update(JSON.stringify({ name: skill.skill_name, evals: skill.evals })).digest("hex").slice(0, 16);
}

export function suiteFromSkillEvals(skill: SkillEvalsJson): FrozenSuite {
  return {
    id: skill.skill_name,
    version: suiteVersion(skill),
    fixtures: skill.evals.map((ev) => {
      const graders: FrozenGrader[] = [];
      if (ev.contains?.length) graders.push({ type: "contains", weight: 1, values: ev.contains });
      if (ev.required_tools?.length || ev.forbidden_tools?.length) {
        graders.push({ type: "tool_call", weight: 1, required: ev.required_tools ?? [], forbidden: ev.forbidden_tools ?? [] });
      }
      const assertions = ev.assertions ?? [];
      if (assertions.length === 0 && graders.length === 0) graders.push({ type: "llm_rubric", weight: 1, rubric: "Response addresses the prompt." });
      for (const rubric of assertions) graders.push({ type: "llm_rubric", weight: 1, rubric });
      return {
        id: `${skill.skill_name}:${ev.id}`,
        prompt: ev.prompt,
        ...(ev.expected_output === undefined ? {} : { goldenOutput: ev.expected_output }),
        graders,
      };
    }),
  };
}

/** Reads one `evals.json`; undefined when absent or malformed (a suite is never guessed). */
export function loadSkillSuite(file: string): FrozenSuite | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<SkillEvalsJson>;
    if (typeof parsed.skill_name !== "string" || !Array.isArray(parsed.evals)) return undefined;
    return suiteFromSkillEvals(parsed as SkillEvalsJson);
  } catch {
    return undefined;
  }
}

/** Merges several skills' suites into one for an agent that runs with all of them. */
export function mergeSuites(agentId: string, suites: readonly FrozenSuite[]): FrozenSuite | undefined {
  if (suites.length === 0) return undefined;
  const version = createHash("sha256").update(suites.map((s) => `${s.id}@${s.version}`).join("|")).digest("hex").slice(0, 16);
  return { id: agentId, version, fixtures: suites.flatMap((s) => s.fixtures) };
}

/**
 * A `SuiteProvider` over a skills tree: an agent's suite is the merge of `<root>/<skill>/evals/evals.json`
 * for every skill it runs with. `skillsFor` comes from the catalog (specialists) or the seat map.
 */
export function fileSuiteProvider(skillsRoot: string, skillsFor: (agentId: string) => readonly string[]): SuiteProvider {
  return (agentId) => {
    const suites = skillsFor(agentId)
      .map((skill) => loadSkillSuite(path.join(skillsRoot, skill, "evals", "evals.json")))
      .filter((s): s is FrozenSuite => s !== undefined);
    return mergeSuites(agentId, suites);
  };
}
