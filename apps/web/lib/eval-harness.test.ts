import { describe, expect, it } from "vitest";
import { runEvalSuite, type EvalFixture } from "@/lib/eval-harness";

describe("eval harness", () => {
  it("scores seat and plug fixtures with deterministic graders and failure tags", async () => {
    const result = await runEvalSuite({
      subjectType: "plug",
      subjectId: "weekly-ops-review",
      version: "1.0.0",
      previousScore: 0.7,
      fixtures: [
        {
          id: "fix_1",
          rubricId: "ops",
          input: { prompt: "Summarize churn risk" },
          expectedState: { outputContains: ["churn", "risk"] },
          actual: { text: "Churn risk is rising", toolCalls: ["metrics_read"] },
          graders: [{ type: "contains", weight: 1, values: ["churn", "risk"] }],
        },
        {
          id: "fix_2",
          rubricId: "contract",
          input: {},
          expectedState: {},
          actual: { text: "missing contract", toolCalls: [] },
          graders: [{ type: "tool_call", weight: 1, required: ["approval_request"] }],
        },
      ],
    });

    expect(result.subjectType).toBe("plug");
    expect(result.score).toBe(0.5);
    expect(result.delta).toBeCloseTo(-0.2);
    expect(result.fixtures[1].failureTags).toContain("missing_tool_call");
  });
});

function rubricFixture(graders: EvalFixture["graders"], actual: EvalFixture["actual"] = {}): EvalFixture {
  return { id: "f1", rubricId: "r", input: "x", actual, graders };
}

describe("eval harness — llm_rubric verdicts (Slice 2)", () => {
  it("scores 0.75 (pending) when no verdict is attached — preserves original behavior", async () => {
    const res = await runEvalSuite({
      subjectType: "plug",
      subjectId: "s",
      version: "v1",
      fixtures: [rubricFixture([{ type: "llm_rubric", weight: 1, rubric: "addresses prompt" }])],
    });
    expect(res.score).toBe(0.75);
    expect(res.failureClusters.llm_judge_pending).toBe(1);
  });

  it("honors a pass verdict (score 1, no failure tag)", async () => {
    const res = await runEvalSuite({
      subjectType: "plug",
      subjectId: "s",
      version: "v1",
      fixtures: [rubricFixture([{ type: "llm_rubric", weight: 1, rubric: "r", verdict: { pass: true } }])],
    });
    expect(res.score).toBe(1);
    expect(res.failureClusters).toEqual({});
  });

  it("honors a fail verdict (score 0, rubric_failed cluster)", async () => {
    const res = await runEvalSuite({
      subjectType: "plug",
      subjectId: "s",
      version: "v1",
      fixtures: [rubricFixture([{ type: "llm_rubric", weight: 1, rubric: "r", verdict: { pass: false } }])],
    });
    expect(res.score).toBe(0);
    expect(res.failureClusters.rubric_failed).toBe(1);
  });

  it("honors a graded partial score from the verdict", async () => {
    const res = await runEvalSuite({
      subjectType: "plug",
      subjectId: "s",
      version: "v1",
      fixtures: [rubricFixture([{ type: "llm_rubric", weight: 1, rubric: "r", verdict: { pass: true, score: 0.6 } }])],
    });
    expect(res.score).toBe(0.6);
  });
});
