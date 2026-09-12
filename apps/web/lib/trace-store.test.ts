import { describe, it, expect } from "vitest";
import {
  deriveTraceRecord,
  shouldDistillSkill,
  InMemoryTraceStore,
  type TraceRecord,
} from "@/lib/trace-store";
import type { StepRecord } from "@/lib/orchestrator-runtime";

function step(overrides: Partial<StepRecord> = {}): StepRecord {
  return {
    id: "s1",
    title: "Analyze churn cohort",
    rationale: "needed",
    agentRole: "analyst",
    dependsOn: [],
    expectedOutput: "summary",
    riskLevel: "low",
    needsApproval: false,
    status: "completed",
    critique: { verdict: "pass", reason: "ok" },
    startedAt: "2026-06-02T00:00:00.000Z",
    completedAt: "2026-06-02T00:00:02.000Z",
    costCents: 12,
    toolCalls: ["sql_query", "chart"] as unknown as StepRecord["toolCalls"],
    ...overrides,
  };
}

function trace(overrides: Partial<TraceRecord> = {}): TraceRecord {
  return {
    id: "t1",
    companyId: "c1",
    runId: "r1",
    taskType: "churn_analysis",
    agentRole: "analyst",
    stepTitle: "step",
    status: "completed",
    toolCalls: [],
    toolCallCount: 0,
    costCents: 0,
    humanCorrected: false,
    createdAt: "2026-06-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("deriveTraceRecord", () => {
  it("derives a queryable record from a completed step", () => {
    const rec = deriveTraceRecord(step(), {
      companyId: "c1",
      runId: "r1",
      taskType: "churn_analysis",
      evalScore: 0.92,
      id: "t-fixed",
      now: "2026-06-02T00:00:05.000Z",
    });
    expect(rec).toMatchObject({
      id: "t-fixed",
      companyId: "c1",
      taskType: "churn_analysis",
      agentRole: "analyst",
      toolCallCount: 2,
      critiqueVerdict: "pass",
      evalScore: 0.92,
      costCents: 12,
      latencyMs: 2000,
      humanCorrected: false,
    });
    expect(rec.toolCalls).toEqual(["sql_query", "chart"]);
  });

  it("captures the critic improvement note (GEPA reflection signal)", () => {
    const rec = deriveTraceRecord(
      step({ critique: { verdict: "retry", reason: "missed cohort", improvement: "pull retention first" } }),
      { companyId: "c1", runId: "r1", taskType: "churn_analysis" },
    );
    expect(rec.critiqueVerdict).toBe("retry");
    expect(rec.improvement).toBe("pull retention first");
  });

  it("leaves latency undefined when timestamps are missing", () => {
    const rec = deriveTraceRecord(step({ startedAt: undefined, completedAt: undefined }), {
      companyId: "c1", runId: "r1", taskType: "x",
    });
    expect(rec.latencyMs).toBeUndefined();
  });

  it("reads tool names from ToolCallRecord.adapter (not 'unknown')", () => {
    // The real runtime shape: ToolCallRecord = { adapter, action, status, summary }.
    const toolCalls = [
      { adapter: "GitHub", action: "open issue", status: "completed", summary: "ok" },
      { adapter: "Steel Browser", action: "scrape", status: "completed", summary: "ok" },
    ] as unknown as StepRecord["toolCalls"];
    const rec = deriveTraceRecord(step({ toolCalls }), {
      companyId: "c1", runId: "r1", taskType: "x",
    });
    expect(rec.toolCalls).toEqual(["GitHub", "Steel Browser"]);
    expect(rec.toolCalls).not.toContain("unknown");
  });

  it("records whether a live skill was applied to the step", () => {
    const applied = deriveTraceRecord(step(), {
      companyId: "c1", runId: "r1", taskType: "x", skillApplied: true,
    });
    expect(applied.skillApplied).toBe(true);
    // Defaults to false when not supplied (honest: unknown ≠ applied).
    const unknown = deriveTraceRecord(step(), { companyId: "c1", runId: "r1", taskType: "x" });
    expect(unknown.skillApplied).toBe(false);
  });
});

describe("shouldDistillSkill", () => {
  it("fires on >= 5 total tool calls across the run", () => {
    const traces = [trace({ toolCallCount: 3 }), trace({ id: "t2", toolCallCount: 2 })];
    const d = shouldDistillSkill(traces);
    expect(d.shouldDistill).toBe(true);
    expect(d.triggers).toContain("tool_call_threshold");
  });

  it("fires on error recovery (retry then a clean pass)", () => {
    const traces = [
      trace({ id: "a", critiqueVerdict: "retry", status: "failed" }),
      trace({ id: "b", critiqueVerdict: "pass", status: "completed" }),
    ];
    expect(shouldDistillSkill(traces).triggers).toContain("error_recovery");
  });

  it("fires on a human correction", () => {
    expect(shouldDistillSkill([trace({ humanCorrected: true })]).triggers).toContain("human_correction");
  });

  it("fires on a high score for a task type with no existing skill", () => {
    const d = shouldDistillSkill([trace({ evalScore: 0.95 })], {
      existingSkillTaskTypes: new Set(["other"]),
    });
    expect(d.triggers).toContain("high_score_no_skill");
  });

  it("suppresses high_score trigger when a skill already exists", () => {
    const d = shouldDistillSkill([trace({ evalScore: 0.95 })], {
      existingSkillTaskTypes: new Set(["churn_analysis"]),
    });
    expect(d.triggers).not.toContain("high_score_no_skill");
  });

  it("does not distill a trivial, low-signal run", () => {
    expect(shouldDistillSkill([trace({ toolCallCount: 1, evalScore: 0.4 })]).shouldDistill).toBe(false);
  });

  it("handles an empty run", () => {
    expect(shouldDistillSkill([])).toEqual({ shouldDistill: false, triggers: [] });
  });
});

describe("InMemoryTraceStore", () => {
  it("appends and queries by company + task type, newest first", async () => {
    const s = new InMemoryTraceStore();
    await s.append(trace({ id: "old", createdAt: "2026-06-01T00:00:00.000Z" }));
    await s.append(trace({ id: "new", createdAt: "2026-06-02T00:00:00.000Z" }));
    await s.append(trace({ id: "other-co", companyId: "c2" }));

    const got = await s.query("c1", "churn_analysis");
    expect(got.map((r) => r.id)).toEqual(["new", "old"]);

    expect((await s.query("c2")).length).toBe(1);
    expect((await s.byRun("r1")).length).toBe(3);
  });
});
