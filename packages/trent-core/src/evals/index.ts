/**
 * `@trent/core` wrapper over `apps/web/lib/eval-harness.ts`.
 *
 * eval-harness.ts has zero imports and is fully deterministic, so this is a
 * thin typed re-export. Types are declared locally rather than re-exported so
 * consumers do not inherit the app's type graph.
 *
 * Wraps: apps/web/lib/eval-harness.ts
 */

import { runEvalSuite as libRunEvalSuite } from "@/lib/eval-harness";

export type EvalSubjectType = "seat" | "plug";

export type EvalGrader =
  | { type: "contains"; weight: number; values: string[] }
  | { type: "tool_call"; weight: number; required?: string[]; forbidden?: string[] }
  | { type: "state_check"; weight: number; expect: Record<string, unknown> }
  | {
      type: "llm_rubric";
      weight: number;
      rubric: string;
      /** A pre-computed judge verdict; absent means the grader scores 0.75 "pending". */
      verdict?: { pass: boolean; score?: number; reason?: string };
    };

export type EvalFixture = {
  id: string;
  rubricId: string;
  input: unknown;
  expectedState?: unknown;
  goldenOutput?: unknown;
  actual: { text?: string; toolCalls?: string[]; state?: Record<string, unknown> };
  graders: EvalGrader[];
};

export type EvalSuiteInput = {
  subjectType: EvalSubjectType;
  subjectId: string;
  version: string;
  previousScore?: number;
  fixtures: EvalFixture[];
};

export type EvalFixtureResult = {
  id: string;
  score: number;
  passed: boolean;
  failureTags: string[];
};

export type EvalSuiteResult = {
  subjectType: EvalSubjectType;
  subjectId: string;
  version: string;
  score: number;
  delta?: number;
  fixtures: EvalFixtureResult[];
  failureClusters: Record<string, number>;
};

/**
 * Score a fixture suite with the app's weighted graders. Deterministic and
 * offline: an `llm_rubric` grader without a pre-computed verdict scores 0.75
 * and tags `llm_judge_pending` rather than calling a model.
 */
export async function runEvalSuite(input: EvalSuiteInput): Promise<EvalSuiteResult> {
  return (await libRunEvalSuite(
    input as unknown as Parameters<typeof libRunEvalSuite>[0],
  )) as unknown as EvalSuiteResult;
}
