/**
 * Task I.15 — the repetitive-loop tag (CS329A L8 @22:56-23:41: the five agent failure modes;
 * this one is detectable from the tool calls with no model call). The same tool with the same
 * args N times in a row tags the trace `repetitive_loop:<tool>`; the gate refuses to promote a
 * candidate whose fixture run carries it.
 */
import { describe, expect, it } from "vitest";

import type { OrcEvent } from "../orchestrator/types.js";
import { executeGate } from "./gate.js";
import type { FrozenSuite } from "./suites.js";
import { InMemoryImproveStore } from "./memory-store.js";
import { detectRepetitiveLoops } from "./repetitive-loop.js";
import { createTraceWriter } from "./trace-writer.js";

const READ_A = { name: "read_file", args: { path: "a" } };

describe("detectRepetitiveLoops", () => {
  it("three identical consecutive calls are a loop; two are not; a different arg breaks the run", () => {
    expect(detectRepetitiveLoops([READ_A, READ_A, READ_A])).toEqual(["repetitive_loop:read_file"]);
    expect(detectRepetitiveLoops([READ_A, READ_A])).toEqual([]);
    expect(detectRepetitiveLoops([READ_A, READ_A, { name: "read_file", args: { path: "b" } }, READ_A])).toEqual([]);
    expect(detectRepetitiveLoops(["GitHub", "GitHub", "GitHub", "memory:read"])).toEqual(["repetitive_loop:GitHub"]);
    expect(detectRepetitiveLoops([READ_A, READ_A, READ_A, READ_A], 4)).toEqual(["repetitive_loop:read_file"]);
    expect(detectRepetitiveLoops([READ_A, READ_A, READ_A], 4)).toEqual([]);
  });
});

const SUITE: FrozenSuite = {
  id: "s",
  version: "v1",
  fixtures: [{ id: "s:1", prompt: "read a", graders: [{ type: "contains", weight: 1, values: ["done"] }] }],
};

describe("executeGate refuses a repetitive loop (I.15)", () => {
  const gate = (invocations: Array<{ name: string; args?: unknown }>) =>
    executeGate({
      candidate: { id: "c", kind: "skill", content: "# skill" },
      seatPrompt: "seat",
      suite: SUITE,
      baseline: { score: 1, failureClusters: {}, fixtures: [{ id: "s:1", passed: true }] },
      actuals: async () => ({ text: "done", toolCalls: invocations.map((i) => i.name), toolInvocations: invocations, costCents: 0 }),
    });

  it("read_file {path:a} three times consecutively tags the fixture and blocks with repetitive_loop", async () => {
    const verdict = await gate([READ_A, READ_A, READ_A]);
    expect(verdict.promoted).toBe(false);
    expect(verdict.blockedBy).toBe("repetitive_loop");
    expect(verdict.fixtures[0]?.failureTags).toContain("repetitive_loop:read_file");
    // The frontier sees it: the tag is a failure cluster.
    expect(verdict.failureClusters["repetitive_loop:read_file"]).toBe(1);
  });

  it("two times is not tagged and the candidate can still be promoted", async () => {
    const verdict = await gate([READ_A, READ_A]);
    expect(verdict.blockedBy).toBeUndefined();
    expect(verdict.fixtures[0]?.failureTags).toEqual([]);
    expect(verdict.promoted).toBe(true);
  });
});

describe("trace writer tags a repetitive loop on the row (I.15)", () => {
  const runStart: OrcEvent = {
    kind: "run_start",
    runId: "run_loop",
    at: "2026-09-13T10:00:00.000Z",
    run: { id: "run_loop", companyId: "co_1", objective: "Read the config file", status: "planning", trigger: "manual" },
  };
  const stepEnd = (id: string, toolCalls: string[]): OrcEvent => ({
    kind: "step_end",
    runId: "run_loop",
    at: "2026-09-13T10:00:00.000Z",
    step: { id, title: "read", agentRole: "engineer", status: "completed", costCents: 1, toolCalls } as unknown as OrcEvent["step"],
  });

  it("three identical consecutive tool calls set failureTags; two leave it empty", async () => {
    const store = new InMemoryImproveStore();
    const writer = createTraceWriter({ store, installedAgents: [] });
    writer.sink(runStart);
    writer.sink(stepEnd("s_loop", ["read_file", "read_file", "read_file"]));
    writer.sink(stepEnd("s_fine", ["read_file", "read_file", "list_dir"]));
    await writer.flush();
    const rows = await store.tracesByRun("run_loop");
    expect(rows.find((r) => r.id.endsWith("s_loop"))?.failureTags).toEqual(["repetitive_loop:read_file"]);
    expect(rows.find((r) => r.id.endsWith("s_fine"))?.failureTags).toEqual([]);
  });
});
