/**
 * The A2A task lifecycle, with no transport involved.
 *
 * The records here are the specification's `Task` objects, so what is asserted is the behaviour the
 * specification promises: one message is one REAL run, the task moves submitted -> working -> a
 * terminal state that the run's own event stream decided, the artifact text is the run's summary,
 * an approval gate becomes `input-required` carrying the gate's own question, and with no runtime
 * attached the submission is refused rather than answered. A fake runner replays a known event
 * sequence; no live model is involved.
 *
 * Source: https://a2a-protocol.org/latest/specification/
 */
import { describe, it, expect } from "vitest";
import type { OrcEvent } from "../orchestrator/types.js";
import { NO_RUNNER_REASON, type AgentRunInput, type AgentRunner } from "../agent-runner/index.js";
import { A2ATaskEngine, A2A_RESULT_ARTIFACT } from "./TaskLifecycle.js";
import { a2aMessageText, A2A_ERROR_NO_RUNTIME, A2A_ERROR_TASK_NOT_CANCELABLE, A2A_ERROR_TASK_NOT_FOUND, JSONRPC_INVALID_PARAMS, type A2AMessageSendParams } from "./spec.js";

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

const OBJECTIVE = "review the billing/ledger boundary in acme/backend";

function params(text = OBJECTIVE): A2AMessageSendParams {
  return { message: { kind: "message", role: "user", messageId: "msg-1", parts: [{ kind: "text", text }] } };
}

/** `begin` then `run`, which is what `message/send` does. Returns the settled task. */
async function submit(engine: A2ATaskEngine, text = OBJECTIVE) {
  const begun = engine.begin(params(text));
  if (!begun.ok) return begun;
  return engine.run(begun.task.id);
}

describe("A2ATaskEngine", () => {
  it("runs the objective and moves submitted -> working -> completed with the run's own output", async () => {
    const answer = "The service boundary between billing and ledger is the risk.";
    const runner = fakeRunner([
      ev("run_start"),
      ev("step_output", { step: { id: "s1", output: "reviewed the dependency graph" } }),
      ev("consolidate_end", { run: { summary: answer } }),
      ev("run_done", { run: { status: "completed", summary: answer } }),
    ]);
    const engine = new A2ATaskEngine({ runner });

    const outcome = await submit(engine);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(engine.states(outcome.task.id).map((s) => s.state)).toEqual(["submitted", "working", "working", "completed"]);
    expect(outcome.task.kind).toBe("task");
    expect(outcome.task.status.state).toBe("completed");
    expect(outcome.task.metadata?.runId).toBe("run_a2a");
    expect(outcome.task.artifacts?.[0]?.name).toBe(A2A_RESULT_ARTIFACT);
    expect(outcome.task.artifacts?.[0]?.parts).toEqual([{ kind: "text", text: answer }]);
    expect(runner.objectives).toEqual([OBJECTIVE]);
    // The stored record is the one that was returned, so a later read is real state.
    expect(engine.get(outcome.task.id)).toEqual(outcome.task);
  });

  it("a failing run becomes a failed task carrying the run's own reason and no artifact", async () => {
    const runner = fakeRunner([ev("run_start"), ev("run_failed", { detail: "every model call failed: provider returned 429" })]);
    const engine = new A2ATaskEngine({ runner });

    const outcome = await submit(engine);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(engine.states(outcome.task.id).map((s) => s.state)).toEqual(["submitted", "working", "failed"]);
    expect(a2aMessageText(outcome.task.status.message)).toBe("every model call failed: provider returned 429");
    expect(outcome.task.artifacts).toEqual([]);
  });

  it("a run parked on an approval gate becomes input-required carrying the gate's own question", async () => {
    const runner = fakeRunner([ev("run_start"), ev("run_awaiting_approval", { detail: "may I drop the legacy index?" })]);
    const engine = new A2ATaskEngine({ runner });

    const outcome = await submit(engine);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.task.status.state).toBe("input-required");
    expect(a2aMessageText(outcome.task.status.message)).toBe("may I drop the legacy index?");
    expect(outcome.task.status.message?.role).toBe("agent");
    expect(outcome.task.artifacts).toEqual([]);
  });

  it("a message naming a task with another context's id is rejected, not adopted (spec 3.4.3 MUST)", async () => {
    const runner = fakeRunner([ev("run_start"), ev("run_awaiting_approval", { detail: "which repo?" })]);
    const engine = new A2ATaskEngine({ runner });
    const waiting = await submit(engine);
    expect(waiting.ok).toBe(true);
    if (!waiting.ok) return;

    const mismatched = engine.begin({ message: { ...params("acme/backend").message, taskId: waiting.task.id, contextId: "ctx-someone-else" } });

    expect(mismatched.ok).toBe(false);
    if (mismatched.ok) return;
    expect(mismatched.error.code).toBe(JSONRPC_INVALID_PARAMS);
    expect(mismatched.error.message).toContain(waiting.task.contextId);
    expect(mismatched.error.message).toContain("ctx-someone-else");
    // The waiting task is untouched: still waiting, its history unchanged.
    const still = engine.get(waiting.task.id);
    expect(still?.status.state).toBe("input-required");
    expect(still?.history).toHaveLength(waiting.task.history?.length ?? 0);

    const matched = engine.begin({ message: { ...params("acme/backend").message, taskId: waiting.task.id, contextId: waiting.task.contextId } });
    expect(matched.ok).toBe(true);
  });

  it("a cancelled run settles on the protocol's own canceled state", async () => {
    const runner = fakeRunner([ev("run_start"), ev("run_cancelled")]);
    const engine = new A2ATaskEngine({ runner });

    const outcome = await submit(engine);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.task.status.state).toBe("canceled");
  });

  it("cancel refuses an unknown id and a task that already finished", async () => {
    const engine = new A2ATaskEngine({ runner: fakeRunner([ev("run_done", { run: { summary: "done" } })]) });
    expect(engine.cancel("never-existed")).toEqual({ ok: false, error: { code: A2A_ERROR_TASK_NOT_FOUND, message: expect.any(String) } });

    const outcome = await submit(engine);
    if (!outcome.ok) return;
    const refused = engine.cancel(outcome.task.id);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe(A2A_ERROR_TASK_NOT_CANCELABLE);
  });

  it("with no runtime attached it refuses, stores nothing, and never reports a task at all", async () => {
    const engine = new A2ATaskEngine();

    const outcome = engine.begin(params());

    expect(engine.hasRunner()).toBe(false);
    expect(outcome).toEqual({ ok: false, error: { code: A2A_ERROR_NO_RUNTIME, message: NO_RUNNER_REASON } });
  });

  it("every transition is timestamped", async () => {
    let tick = 0;
    const runner = fakeRunner([ev("run_done", { run: { summary: "done" } })]);
    const engine = new A2ATaskEngine({
      runner,
      now: () => `2026-09-18T00:00:0${String(tick++)}.000Z`,
      newId: (kind) => `${kind}-fixed`,
    });

    const outcome = await submit(engine);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.task.id).toBe("task-fixed");
    expect(engine.states(outcome.task.id).map((s) => s.timestamp)).toEqual([
      "2026-09-18T00:00:00.000Z",
      "2026-09-18T00:00:01.000Z",
      "2026-09-18T00:00:02.000Z",
    ]);
  });
});
