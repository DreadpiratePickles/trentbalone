import { describe, expect, it } from "vitest";
import { runEvalSuite } from "@/lib/eval-harness";

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
