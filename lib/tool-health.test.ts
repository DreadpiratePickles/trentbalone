import { describe, it, expect } from "vitest";
import {
  computeToolHealth,
  degradedTools,
  skillsDependentOnTool,
  cascadeDegradedSkills,
} from "@/lib/tool-health";
import type { TraceRecord } from "@/lib/trace-store";

function trace(overrides: Partial<TraceRecord> = {}): TraceRecord {
  return {
    id: "t",
    companyId: "c1",
    runId: "r1",
    taskType: "churn_analysis",
    agentRole: "analyst",
    stepTitle: "step",
    status: "completed",
    toolCalls: [],
    toolCallCount: 0,
    costCents: 1,
    humanCorrected: false,
    createdAt: "2026-06-02T00:00:00.000Z",
    critiqueVerdict: "pass",
    ...overrides,
  };
}

describe("computeToolHealth", () => {
  it("counts appearances and implicated failures per tool", () => {
    const traces = [
      trace({ toolCalls: ["sql_query", "chart"], status: "completed", critiqueVerdict: "pass" }),
      trace({ toolCalls: ["sql_query"], status: "failed", critiqueVerdict: "escalate" }),
      trace({ toolCalls: ["sql_query"], status: "completed", critiqueVerdict: "retry" }),
    ];
    const health = computeToolHealth(traces);
    const sql = health.get("sql_query")!;
    expect(sql.appearances).toBe(3);
    expect(sql.implicatedFailures).toBe(2); // failed + retry
    expect(sql.successRate).toBeCloseTo(1 / 3);
    expect(health.get("chart")!.successRate).toBe(1);
  });

  it("de-dupes a tool repeated within one step", () => {
    const health = computeToolHealth([trace({ toolCalls: ["sql_query", "sql_query"] })]);
    expect(health.get("sql_query")!.appearances).toBe(1);
  });
});

describe("degradedTools", () => {
  it("flags tools below the success threshold with enough samples", () => {
    const traces = [
      trace({ toolCalls: ["flaky_api"], status: "failed", critiqueVerdict: "escalate" }),
      trace({ toolCalls: ["flaky_api"], status: "failed", critiqueVerdict: "escalate" }),
      trace({ toolCalls: ["flaky_api"], status: "completed", critiqueVerdict: "pass" }),
      trace({ toolCalls: ["solid_api"], status: "completed", critiqueVerdict: "pass" }),
    ];
    const degraded = degradedTools(computeToolHealth(traces));
    expect(degraded.map((d) => d.tool)).toEqual(["flaky_api"]);
  });

  it("ignores tools below the minimum appearance count", () => {
    const degraded = degradedTools(
      computeToolHealth([trace({ toolCalls: ["rare"], status: "failed" })]),
    );
    expect(degraded).toHaveLength(0);
  });
});

describe("skillsDependentOnTool", () => {
  it("matches whole tool tokens, not substrings", () => {
    const live = new Map<string, string>([
      ["churn_analysis", "## Tools used\n- sql_query\n- chart"],
      ["report_gen", "uses sqlite locally"], // must NOT match `sql`
    ]);
    expect(skillsDependentOnTool("sql_query", live)).toEqual(["churn_analysis"]);
    expect(skillsDependentOnTool("sql", live)).toEqual([]);
  });
});

describe("cascadeDegradedSkills", () => {
  it("returns task types whose live skill depends on a degraded tool", () => {
    const traces = [
      trace({ toolCalls: ["github_api"], status: "failed", critiqueVerdict: "escalate" }),
      trace({ toolCalls: ["github_api"], status: "failed", critiqueVerdict: "escalate" }),
      trace({ toolCalls: ["github_api"], status: "completed", critiqueVerdict: "pass" }),
    ];
    const live = new Map<string, string>([
      ["pr_review", "## Tools used\n- github_api"],
      ["churn_analysis", "## Tools used\n- sql_query"],
    ]);
    const { degradedTaskTypes, tools } = cascadeDegradedSkills(traces, live);
    expect(tools.map((t) => t.tool)).toContain("github_api");
    expect([...degradedTaskTypes]).toEqual(["pr_review"]);
  });
});
