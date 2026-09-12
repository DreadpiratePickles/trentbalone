import { describe, it, expect } from "vitest";
import {
  shouldDistillSkill,
  deriveTrace,
  InMemoryTraceStore,
  type TraceRecord,
} from "./trace-store.js";

/**
 * Two traces from one run: a step the critic told to retry, then a step that
 * completed with a pass verdict. Two tool calls in total — deliberately BELOW
 * the default threshold of 5, so a passing test proves error_recovery fired on
 * its own and the tool-call trigger did not.
 */
function runTraces(): TraceRecord[] {
  return [
    {
      id: "trace_run1_s1",
      companyId: "co_1",
      runId: "run1",
      taskType: "ship-migration",
      agentRole: "engineer",
      stepTitle: "Apply migration",
      status: "failed",
      toolCalls: ["Postgres"],
      toolCallCount: 1,
      critiqueVerdict: "retry",
      improvement: "Take a snapshot before applying the migration.",
      costCents: 4,
      humanCorrected: false,
      skillApplied: false,
      createdAt: "2026-09-01T00:00:00.000Z",
    },
    {
      id: "trace_run1_s2",
      companyId: "co_1",
      runId: "run1",
      taskType: "ship-migration",
      agentRole: "engineer",
      stepTitle: "Re-apply migration after snapshot",
      status: "completed",
      toolCalls: ["Postgres"],
      toolCallCount: 1,
      critiqueVerdict: "pass",
      costCents: 5,
      humanCorrected: false,
      skillApplied: false,
      createdAt: "2026-09-01T00:05:00.000Z",
    },
  ];
}

describe("traces wrapper — distillation triggers", () => {
  it("fires error_recovery only, proving the 2-tool-call run stayed under the threshold", () => {
    const decision = shouldDistillSkill(runTraces());
    expect(decision.shouldDistill).toBe(true);
    expect(decision.triggers).toEqual(["error_recovery"]);
  });

  it("fires tool_call_threshold once the same run crosses 5 tool calls", () => {
    const traces = runTraces();
    traces[0].toolCallCount = 4;
    const decision = shouldDistillSkill(traces);
    expect(decision.triggers).toContain("tool_call_threshold");
    expect(decision.triggers).toContain("error_recovery");
  });

  it("distills nothing from an empty run", () => {
    expect(shouldDistillSkill([])).toEqual({ shouldDistill: false, triggers: [] });
  });
});

describe("traces wrapper — derivation and the in-memory store", () => {
  it("derives a trace record from a step, reading the tool name from adapter", () => {
    const record = deriveTrace(
      {
        id: "s1",
        title: "Apply migration",
        agentRole: "engineer",
        status: "completed",
        toolCalls: [{ adapter: "Postgres" }],
        critique: { verdict: "pass", reason: "clean" },
        costCents: 7,
        startedAt: "2026-09-01T00:00:00.000Z",
        completedAt: "2026-09-01T00:00:02.000Z",
      },
      { companyId: "co_1", runId: "run1", taskType: "ship-migration", now: "2026-09-01T00:00:02.000Z" },
    );
    expect(record.toolCalls).toEqual(["Postgres"]);
    expect(record.toolCallCount).toBe(1);
    expect(record.latencyMs).toBe(2000);
    expect(record.critiqueVerdict).toBe("pass");
    expect(record.humanCorrected).toBe(false);
  });

  it("returns a company's traces newest first and filters by task type", async () => {
    const store = new InMemoryTraceStore();
    for (const t of runTraces()) await store.append(t);
    await store.append({ ...runTraces()[0], id: "other", taskType: "write-changelog" });
    const all = await store.query("co_1");
    expect(all.map((t) => t.id)).toEqual(["trace_run1_s2", "trace_run1_s1", "other"]);
    const filtered = await store.query("co_1", "write-changelog");
    expect(filtered.map((t) => t.id)).toEqual(["other"]);
  });
});
