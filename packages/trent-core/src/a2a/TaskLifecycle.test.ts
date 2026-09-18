/**
 * The A2A task lifecycle, with no transport involved.
 *
 * The A2A wire shape Trent serves today is its own, not the specification's Task/Message/Part
 * schema, and is expected to be replaced for Hermes interop. What must survive that swap is
 * asserted here: a task is a REAL run, it moves submitted -> working -> a terminal state that the
 * run's own event stream decided, the artifact text is the run's summary, and with no runtime
 * attached the submission is refused rather than answered. A fake runner replays a known event
 * sequence; no live model is involved.
 */
import { describe, it, expect } from "vitest";
import type { OrcEvent } from "../orchestrator/types.js";
import { NO_RUNNER_REASON, type AgentRunInput, type AgentRunner } from "../agent-runner/index.js";
import { A2ATaskEngine, A2A_RESULT_ARTIFACT, type A2ATaskRequest } from "./TaskLifecycle.js";

function ev(kind: OrcEvent["kind"], extra: Partial<OrcEvent> = {}): OrcEvent {
  return { kind, runId: "run_a2a", at: "2026-09-18T00:00:00.000Z", ...extra } as OrcEvent;
}

function fakeRunner(events: readonly OrcEvent[]): AgentRunner & { objectives: string[] } {
  const objectives: string[] = [];
  return {
    objectives,
    run(input: AgentRunInput) {
      objectives.push(input.objective);
      return (async function* () {
        for (const event of events) yield event;
      })();
    },
  };
}

const request: A2ATaskRequest = {
  id: "task-001",
  agent: "engineer",
  taskType: "architecture-review",
  objective: "review the billing/ledger boundary in acme/backend",
};

describe("A2ATaskEngine", () => {
  it("runs the objective and moves submitted -> working -> completed with the run's own output", async () => {
    const answer = "The service boundary between billing and ledger is the risk.";
    const runner = fakeRunner([
      ev("run_start"),
      ev("step_end", { step: { id: "s1", output: "reviewed the dependency graph" } }),
      ev("consolidate_end", { run: { summary: answer } }),
      ev("run_done", { run: { status: "completed", summary: answer } }),
    ]);
    const engine = new A2ATaskEngine({ runner });

    const outcome = await engine.submit(request);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.task.history.map((h) => h.state)).toEqual(["submitted", "working", "completed"]);
    expect(outcome.task.status.state).toBe("completed");
    expect(outcome.task.runId).toBe("run_a2a");
    expect(outcome.task.artifacts).toEqual([
      { name: A2A_RESULT_ARTIFACT, parts: [{ type: "text", text: answer }] },
    ]);
    expect(outcome.task.error).toBeUndefined();
    expect(runner.objectives).toEqual([request.objective]);
    // The stored record is the one that was returned, so a later read is real state.
    expect(engine.get("task-001")).toEqual(outcome.task);
  });

  it("a failing run becomes a failed task carrying the run's own reason and no artifact", async () => {
    const runner = fakeRunner([
      ev("run_start"),
      ev("run_failed", { detail: "every model call failed: provider returned 429" }),
    ]);
    const engine = new A2ATaskEngine({ runner });

    const outcome = await engine.submit(request);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.task.history.map((h) => h.state)).toEqual(["submitted", "working", "failed"]);
    expect(outcome.task.error).toBe("every model call failed: provider returned 429");
    expect(outcome.task.artifacts).toEqual([]);
  });

  it("a run parked on an approval gate becomes input-required, never completed", async () => {
    const runner = fakeRunner([ev("run_start"), ev("run_awaiting_approval", { step: { id: "s1" } })]);
    const engine = new A2ATaskEngine({ runner });

    const outcome = await engine.submit(request);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.task.status.state).toBe("input-required");
    expect(outcome.task.artifacts).toEqual([]);
  });

  it("a cancelled run settles on the protocol's own canceled state", async () => {
    const runner = fakeRunner([ev("run_start"), ev("run_cancelled")]);
    const engine = new A2ATaskEngine({ runner });

    const outcome = await engine.submit(request);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.task.status.state).toBe("canceled");
  });

  it("with no runtime attached it refuses, stores nothing, and never reports a task at all", async () => {
    const engine = new A2ATaskEngine();

    const outcome = await engine.submit(request);

    expect(engine.hasRunner()).toBe(false);
    expect(outcome).toEqual({ ok: false, reason: NO_RUNNER_REASON });
    expect(engine.get("task-001")).toBeUndefined();
  });

  it("every transition is timestamped", async () => {
    let tick = 0;
    const runner = fakeRunner([ev("run_done", { run: { summary: "done" } })]);
    const engine = new A2ATaskEngine({ runner, now: () => `2026-09-18T00:00:0${String(tick++)}.000Z` });

    const outcome = await engine.submit(request);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.task.history.map((h) => h.timestamp)).toEqual([
      "2026-09-18T00:00:00.000Z",
      "2026-09-18T00:00:01.000Z",
      "2026-09-18T00:00:02.000Z",
    ]);
  });
});
