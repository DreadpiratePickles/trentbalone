/**
 * [S1] The solo loop's happy paths: an answer, one tool, three tools. Every case asserts the exact
 * OrcEvent sequence the surfaces consume, what the model was told, what the session kept and what
 * the meter was charged. The gateway is a script; no model is called.
 */
import { describe, expect, it } from "vitest";
import { createAgentRunFold } from "../agent-runner/index.js";
import type { OrcEvent } from "../orchestrator/types.js";
import {
  FIXED_NOW,
  collect,
  fakeAdapter,
  fakeMemory,
  fakeMeter,
  kinds,
  memorySession,
  scriptedGateway,
  sequentialIds,
  toolCall,
  toolCallsOf,
  transcriptOf,
  type FakeAdapter,
  type ScriptStep,
} from "./fakes.test-helpers.js";
import { createSoloRunner } from "./runner.js";
import type { SoloConfig } from "./types.js";

function setup(script: readonly ScriptStep[], adapters: FakeAdapter[] = [], config: SoloConfig = {}) {
  const gateway = scriptedGateway(script);
  const session = memorySession();
  const meter = fakeMeter({ centsPerCall: 2 });
  const memory = fakeMemory();
  const runner = createSoloRunner({ gateway, tools: { adapters }, session, memory: memory.memory, meter, now: FIXED_NOW, newId: sequentialIds(), config, companyId: "co_1" });
  return { gateway, session, meter, memory, runner };
}

function fold(events: readonly OrcEvent[]) {
  const f = createAgentRunFold();
  for (const event of events) f.apply(event);
  return f.outcome();
}

const ANSWER = "Your oak tables ship in 5 working days.";

describe("[S1] a turn with no tool: the reply is the run's answer", () => {
  it("emits run_start, one step for seat trent, the answer, step_end and run_done, exactly", async () => {
    const { runner, session, meter, gateway } = setup([ANSWER]);
    const events = await collect(runner.run({ objective: "How long does shipping take?" }));

    expect(kinds(events)).toEqual(["run_start", "step_start", "step_output", "step_end", "run_done"]);
    expect(events.every((e) => e.runId === "solo_1")).toBe(true);
    expect(events[0]?.run).toMatchObject({ id: "solo_1", objective: "How long does shipping take?", status: "running" });
    expect(events[1]?.step).toMatchObject({ id: "solo_1-trent", agentRole: "trent", status: "running" });
    expect(events[2]?.step).toMatchObject({ id: "solo_1-trent", agentRole: "trent", output: ANSWER });
    expect(toolCallsOf(events[2])).toEqual([]);
    expect(events[3]?.step).toMatchObject({ id: "solo_1-trent", status: "completed", costCents: 2, tokens: 120, model: "gemini-test" });
    expect(events[3]?.step?.output).toBeUndefined();
    expect(events[4]?.run).toMatchObject({ id: "solo_1", status: "completed", summary: ANSWER });

    expect(fold(events)).toMatchObject({ status: "completed", output: ANSWER, runId: "solo_1" });
    expect(session.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "How long does shipping take?"],
      ["assistant", ANSWER],
    ]);
    expect(meter.opened).toEqual(["solo_1"]);
    expect(meter.closed).toEqual(["solo_1"]);
    expect(meter.calls).toHaveLength(1);
    expect(meter.calls[0]?.call).toMatchObject({ seat: "trent", stepId: "solo_1-trent", model: "gemini-test", provider: "google", inputTokens: 100, outputTokens: 20 });
    expect(gateway.requests).toHaveLength(1);
  });

  it("sends the pin as the request's explicit model, and the abort signal, on every call", async () => {
    const { runner, gateway } = setup([ANSWER], [], { model: "gemini-3.5-flash-lite" });
    const controller = new AbortController();
    await collect(runner.run({ objective: "Ship time?", signal: controller.signal }));
    expect(gateway.requests[0]).toMatchObject({ model: "gemini-3.5-flash-lite", role: "executor" });
    expect(gateway.requests[0]?.signal).toBe(controller.signal);
  });
});

describe("[S1] a turn with tools: model -> tool -> model until an answer", () => {
  it("one tool then an answer: the result reaches the model and the stream carries it as step_output", async () => {
    const files = fakeAdapter({ name: "file_ops", tools: ["read_file", "write_file"] });
    const { runner, gateway, session, meter } = setup([toolCall('read_file {"path": "SHIPPING.md"}'), ANSWER], [files]);
    const events = await collect(runner.run({ objective: "How long does shipping take?" }));

    expect(kinds(events)).toEqual(["run_start", "step_start", "step_output", "step_output", "step_end", "run_done"]);
    expect(toolCallsOf(events[2])).toEqual([
      { adapter: "file_ops", action: 'read_file {"path": "SHIPPING.md"}', status: "completed", summary: 'file_ops ran read_file {"path": "SHIPPING.md"}' },
    ]);
    expect(events[2]?.step?.output).toBeUndefined();
    expect(events[3]?.step).toMatchObject({ output: ANSWER });
    expect(toolCallsOf(events[3])).toHaveLength(1);
    expect(events[4]?.step).toMatchObject({ status: "completed", costCents: 4, tokens: 240 });
    expect(events[5]?.run).toMatchObject({ status: "completed", summary: ANSWER });

    // The adapter ran inside the run's tool-call context, with the seat loop's payload.
    expect(files.calls).toEqual([{ action: 'read_file {"path": "SHIPPING.md"}', payload: { companyId: "co_1" }, context: { runId: "solo_1", stepId: "solo_1-trent" } }]);
    // The second call carried the model's own reply and the tool's result, in that order.
    const told = transcriptOf(gateway.requests[1]);
    expect(told.at(-2)).toBe(`assistant: ${toolCall('read_file {"path": "SHIPPING.md"}')}`);
    expect(told.at(-1)).toContain('file_ops ran read_file {"path": "SHIPPING.md"}');
    expect(told.at(-1)).toContain('status="completed"');
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(session.messages[2]?.record?.status).toBe("completed");
    expect(meter.calls.map((c) => c.call.seat)).toEqual(["trent", "trent"]);
  });

  it("three tools over two replies: each result is one step_output with the cumulative list", async () => {
    const files = fakeAdapter({ name: "file_ops", tools: ["read_file", "search_files"] });
    const todo = fakeAdapter({ name: "todo", tools: ["todo"] });
    const first = `I will look first.\n${toolCall('read_file {"path": "a.md"}')}\n${toolCall('search_files {"pattern": "oak"}')}`;
    const { runner, gateway, session } = setup([first, toolCall('todo {"action": "add", "text": "stain"}'), ANSWER], [files, todo]);
    const events = await collect(runner.run({ objective: "Plan the oak order." }));

    expect(kinds(events)).toEqual(["run_start", "step_start", "step_note", "step_output", "step_output", "step_output", "step_output", "step_end", "run_done"]);
    expect(events[2]?.detail).toBe("I will look first.");
    expect(events.slice(3, 7).map((e) => toolCallsOf(e).length)).toEqual([1, 2, 3, 3]);
    expect(toolCallsOf(events[5]).map((r) => r.adapter)).toEqual(["file_ops", "file_ops", "todo"]);
    expect(events[6]?.step?.output).toBe(ANSWER);
    expect(events[7]?.step).toMatchObject({ status: "completed", costCents: 6, tokens: 360 });
    expect(gateway.requests).toHaveLength(3);
    // Both results of the first reply went back to the model as ONE message, after its reply.
    const told = transcriptOf(gateway.requests[1]);
    expect(told.at(-2)).toBe(`assistant: ${first}`);
    expect(told.at(-1)).toMatch(/^user: <tool_result tool="read_file" status="completed">[\s\S]*<tool_result tool="search_files" status="completed">/);
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "tool", "assistant", "tool", "assistant"]);
  });
});
