/**
 * Task I.13 — clean-trace distillation (CS329A L5 @72:47-73:10, SWiRL: imitation needs
 * process-AND-outcome-clean data; L5 @67:02 process filter). A promoted candidate's raw trace
 * still carries the dead ends; the golden keeps only the successful path.
 */
import { describe, expect, it } from "vitest";

import type { AgentTraceRow } from "../store/StorePort.js";
import { distillCleanTrace, rawTraceFromRows, type RawTrace } from "./clean-trace.js";

const RAW: RawTrace = {
  id: "trace_raw_1",
  runId: "run_1",
  agentId: "engineer",
  taskType: "ship-feature",
  objective: "Ship the feature",
  blocked: false,
  steps: [
    { title: "read the file", tool: "read_file", args: { path: "a" }, ok: false, error: "ENOENT" },
    { title: "read the file again", tool: "read_file", args: { path: "b" }, ok: false, error: "ENOENT" },
    { title: "list the directory", tool: "list_dir", args: { path: "." }, ok: true, output: "a.ts b.ts" },
    { title: "read the file", tool: "read_file", args: { path: "a.ts" }, ok: true, output: "export const a = 1" },
    { title: "answer", ok: true, output: "a is 1" },
  ],
};

describe("distillCleanTrace (I.13)", () => {
  it("a promoted trace with two failed tool calls before success yields a golden of only the successful steps, pointing at the raw trace", () => {
    const golden = distillCleanTrace(RAW, { candidateId: "skill_1", now: "2026-09-13T10:00:00.000Z" });
    expect(golden).toBeDefined();
    expect(golden!.distilledFrom).toBe("trace_raw_1");
    expect(golden!.steps.map((s) => s.title)).toEqual(["list the directory", "read the file", "answer"]);
    expect(golden!.steps.every((s) => s.error === undefined)).toBe(true);
    expect(golden!.candidateId).toBe("skill_1");
    expect(golden!.rationale).toBeUndefined();
  });

  it("never distils from a trace that was blocked", () => {
    expect(distillCleanTrace({ ...RAW, blocked: true }, { candidateId: "skill_1", now: "t" })).toBeUndefined();
  });

  it("never distils from a trace whose final step did not succeed (outcome not clean)", () => {
    const steps = [...RAW.steps.slice(0, 4), { title: "answer", ok: false, error: "gave up" }];
    expect(distillCleanTrace({ ...RAW, steps }, { candidateId: "skill_1", now: "t" })).toBeUndefined();
  });

  it("a run's trace rows become one raw trace: retried and failed steps are not ok, a blocked step blocks the trace", () => {
    const row = (id: string, status: string, verdict: string | null): AgentTraceRow => ({
      id,
      companyId: "co",
      agentRole: "engineer",
      agentId: "engineer",
      runId: "run_9",
      taskType: "ship-feature",
      stepTitle: `step ${id}`,
      status,
      toolCalls: ["GitHub"],
      toolCallCount: 1,
      critiqueVerdict: verdict,
      improvement: null,
      evalScore: null,
      costCents: 1,
      latencyMs: null,
      humanCorrected: false,
      skillApplied: false,
      createdAt: `2026-09-13T10:00:0${id}.000Z`,
    });
    const raw = rawTraceFromRows([row("1", "completed", "retry"), row("2", "completed", "pass"), row("3", "failed", null)]);
    expect(raw.id).toBe("run_9");
    expect(raw.steps.map((s) => s.ok)).toEqual([false, true, false]);
    expect(raw.blocked).toBe(false);
    expect(rawTraceFromRows([row("1", "blocked", null)]).blocked).toBe(true);
  });
});
