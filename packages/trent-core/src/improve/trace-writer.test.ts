/**
 * Item 1 — write the traces. Until this lands every downstream stage computes over zero rows.
 * The run here is a REAL offline orchestration through the wrapper; nothing is hand-built.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { OrcEvent, OrchestrationRunSnapshot } from "../orchestrator/types.js";
import { InMemoryImproveStore } from "./memory-store.js";
import { createImproveHook, createTraceWriter, deriveTaskType } from "./index.js";
import { bootOffline, imitateCompiledBinary, restoreEnv } from "./offline-harness.js";

describe("trace writer — one trace per finished step, from the bus", () => {
  const store = new InMemoryImproveStore();
  let events: OrcEvent[] = [];
  let snapshot: OrchestrationRunSnapshot;
  let companyId = "";
  let objective = "";

  beforeAll(async () => {
    imitateCompiledBinary();
    const harness = await bootOffline("ImproveTraces");
    companyId = harness.companyId;
    objective = harness.objective;
    const { createOrchestrator } = await import("../orchestrator/index.js");
    const hook = createImproveHook({
      store: store,
      installedAgents: ["ceo", "engineer", "growth", "content", "support", "analyst", "finance", "browser", "escalation"],
    });
    const orchestrator = createOrchestrator({
      createCompletion: harness.createCompletion,
      executeSeatModelFn: harness.executeSeatModelFn,
      improve: hook,
    });
    const handle = orchestrator.run({ companyId, objective });
    for await (const event of handle) events.push(event);
    snapshot = await handle.result();
  }, 120_000);

  afterAll(restoreEnv);

  it("the run finished with real steps", () => {
    expect(["completed", "failed"]).toContain(snapshot.status);
    expect(snapshot.steps.length).toBeGreaterThan(1);
  });

  it("holds exactly one trace per step_end/step_blocked seen on the bus, keyed by (company, agent, taskType)", async () => {
    const finished = events.filter((e) => e.kind === "step_end" || e.kind === "step_blocked");
    const finishedIds = new Set(finished.map((e) => e.step?.id));
    const traces = await store.tracesByRun(snapshot.id);
    expect(traces.length).toBe(finishedIds.size);
    for (const trace of traces) {
      expect(trace.companyId).toBe(companyId);
      expect(trace.taskType).toBe(deriveTaskType(objective));
      expect(trace.agentId).toBe(trace.agentRole);
      expect(finishedIds.has(trace.id.replace(`trace_${snapshot.id}_`, ""))).toBe(true);
    }
  });

  it("populates the critique verdict and tool-call count from the step", async () => {
    const traces = await store.tracesByRun(snapshot.id);
    const completed = traces.filter((t) => t.status === "completed");
    expect(completed.length).toBeGreaterThan(0);
    expect(completed.some((t) => t.critiqueVerdict !== null)).toBe(true);
    for (const t of traces) {
      expect(t.toolCallCount).toBe(t.toolCalls.length);
      expect(Number.isInteger(t.costCents)).toBe(true);
    }
  });

  it("only the nine seats and installed specialists get traces; an uninstalled specialist never does", async () => {
    const counts = await store.countTracesByAgent(companyId);
    const agents = Object.keys(counts);
    expect(agents.length).toBeGreaterThan(0);
    for (const agent of agents) {
      expect(["ceo", "engineer", "growth", "content", "support", "analyst", "finance", "browser", "escalation", "sales"]).toContain(agent);
    }
    expect(counts["spec-uninstalled-specialist"]).toBeUndefined();
  });
});

describe("trace writer — scope rule on a synthetic step_end", () => {
  const stepEnd = (runId: string, role: string): OrcEvent => ({
    kind: "step_end",
    runId,
    at: "2026-09-12T10:00:00.000Z",
    step: { id: "s1", title: "do it", agentRole: role, status: "completed", costCents: 2 } as OrcEvent["step"],
  });
  const runStart = (runId: string, companyId: string): OrcEvent => ({
    kind: "run_start",
    runId,
    at: "2026-09-12T10:00:00.000Z",
    run: { id: runId, companyId, objective: "Draft the weekly investor update", status: "planning", trigger: "manual" },
  });

  it("an installed specialist plugged into a seat is traced under its own agent id", async () => {
    const store = new InMemoryImproveStore();
    const writer = createTraceWriter({
      store,
      installedAgents: ["eng-ai-engineer"],
      resolveAgentId: async () => "eng-ai-engineer",
    });
    writer.sink(runStart("run_x", "co_1"));
    writer.sink(stepEnd("run_x", "engineer"));
    await writer.flush();
    const traces = await store.tracesByRun("run_x");
    expect(traces.map((t) => t.agentId)).toEqual(["eng-ai-engineer"]);
    expect(traces[0]?.agentRole).toBe("engineer");
  });

  it("an UNINSTALLED specialist plugged into a seat produces no trace at all", async () => {
    const store = new InMemoryImproveStore();
    const writer = createTraceWriter({
      store,
      installedAgents: [],
      resolveAgentId: async () => "spec-not-installed",
    });
    writer.sink(runStart("run_y", "co_1"));
    writer.sink(stepEnd("run_y", "engineer"));
    await writer.flush();
    expect(await store.tracesByRun("run_y")).toEqual([]);
  });
});
