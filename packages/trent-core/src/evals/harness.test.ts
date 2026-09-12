import { describe, it, expect } from "vitest";
import { runEvalSuite, type EvalSuiteInput } from "./index.js";

/**
 * Behavioural contract for the eval-harness wrapper.
 *
 * The suite below is built so the arithmetic can only come out right if the
 * real weighted grader in apps/web/lib/eval-harness.ts is doing the work:
 *   fixture A -> contains(w=3, passes) + tool_call(w=1, fails) = 3/4 = 0.75
 *   fixture B -> llm_rubric(w=1, no verdict)                   =       0.75
 *   suite     -> mean(0.75, 0.75)                              =       0.75
 */
const suite: EvalSuiteInput = {
  subjectType: "seat",
  subjectId: "seat-engineer",
  version: "1.0.0",
  previousScore: 0.5,
  fixtures: [
    {
      id: "fixture-a",
      rubricId: "rubric-a",
      input: { ask: "ship the migration" },
      actual: { text: "Migration applied and verified", toolCalls: ["GitHub"] },
      graders: [
        { type: "contains", weight: 3, values: ["migration applied"] },
        { type: "tool_call", weight: 1, required: ["Postgres"] },
      ],
    },
    {
      id: "fixture-b",
      rubricId: "rubric-b",
      input: { ask: "write the changelog" },
      actual: { text: "Changelog drafted" },
      graders: [{ type: "llm_rubric", weight: 1, rubric: "Is the changelog accurate?" }],
    },
  ],
};

describe("evals wrapper — weighted grading", () => {
  it("scores the two-fixture suite at exactly 0.75 with a 0.25 delta", async () => {
    const result = await runEvalSuite(suite);
    expect(result.score).toBe(0.75);
    expect(result.delta).toBe(0.25);
  });

  it("clusters exactly one missing_tool_call and one llm_judge_pending failure", async () => {
    const result = await runEvalSuite(suite);
    expect(result.failureClusters).toEqual({ missing_tool_call: 1, llm_judge_pending: 1 });
  });

  it("marks both fixtures failed because 0.75 is below the 0.8 pass bar", async () => {
    const result = await runEvalSuite(suite);
    expect(result.fixtures.map((f) => [f.id, f.score, f.passed])).toEqual([
      ["fixture-a", 0.75, false],
      ["fixture-b", 0.75, false],
    ]);
  });

  it("omits delta when no previous score is supplied", async () => {
    const result = await runEvalSuite({ ...suite, previousScore: undefined });
    expect(result.delta).toBeUndefined();
  });
});
