/**
 * [S1] The solo loop's happy paths: an answer, one tool, three tools. Every case asserts the exact
 * OrcEvent sequence the surfaces consume, what the model was told, what the session kept and what
 * the meter was charged. The gateway is a script; no model is called.
 */
import { describe, expect, it } from "vitest";
import { createAgentRunFold } from "../agent-runner/index.js";
import { collectCompletion } from "../model-gateway/complete.js"; // [C13]
import type { GatewayStreamEvent, GatewayStreamRequest } from "../model-gateway/types.js"; // [C13]
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

describe("[S1.1] C1: the runner speaks the model's own format", () => {
  it("a Hermes body runs the adapter with the normalised action, and <think> reaches neither the next request nor the session", async () => {
    const files = fakeAdapter({ name: "file_ops", tools: ["read_file"] });
    const call = '<think>I should read it first.</think>\n<tool_call>\n{"name": "read_file", "arguments": {"path": "SHIPPING.md"}}\n</tool_call>';
    const { runner, gateway, session } = setup([call, "<think>easy</think>Five working days."], [files]);
    const events = await collect(runner.run({ objective: "How long does shipping take?" }));

    expect(files.calls.map((c) => c.action)).toEqual(['read_file {"path":"SHIPPING.md"}']);
    expect(events.at(-1)?.run).toMatchObject({ status: "completed", summary: "Five working days." });
    const told = transcriptOf(gateway.requests[1]);
    expect(told.at(-2)).toBe('assistant: <tool_call>\n{"name": "read_file", "arguments": {"path": "SHIPPING.md"}}\n</tool_call>');
    expect(session.messages.map((m) => m.content).join("\n")).not.toContain("think");
  });

  it("passes a configured responseFormat on every request, reads the envelope it asks for, and sends none by default", async () => {
    const files = fakeAdapter({ name: "file_ops", tools: ["read_file"] });
    const responseFormat = { type: "json_schema" as const, json_schema: { name: "solo_turn", schema: { type: "object" } } };
    const { runner, gateway } = setup(['{"tool_calls": [{"name": "read_file", "arguments": {"path": "a.md"}}]}', '{"answer": "Done."}'], [files], { responseFormat });
    const events = await collect(runner.run({ objective: "Read a.md" }));
    expect(gateway.requests.map((r) => (r as { responseFormat?: unknown }).responseFormat)).toEqual([responseFormat, responseFormat]);
    expect(files.calls.map((c) => c.action)).toEqual(['read_file {"path":"a.md"}']);
    expect(events.at(-1)?.run).toMatchObject({ summary: "Done." });

    const plain = setup(["Hi."]);
    await collect(plain.runner.run({ objective: "Hello" }));
    expect("responseFormat" in (plain.gateway.requests[0] ?? {})).toBe(false);
  });
});

// [C13] the answer streams while the model writes
/**
 * A gateway that streams, as `ModelGateway.stream()` does: each reply's tokens `gapMs` apart, then usage and finish.
 * Its `complete()` drains the same stream, so a turn that only calls `complete()` sees the same reply, at the end.
 */
function streamingGateway(replies: readonly (readonly string[])[], gapMs = 100) {
  const requests: GatewayStreamRequest[] = [];
  const tokenAt: number[] = [];
  let closed = 0;
  async function* stream(request: GatewayStreamRequest): AsyncGenerator<GatewayStreamEvent> {
    requests.push(request);
    const tokens = replies[requests.length - 1];
    if (tokens === undefined) throw new Error(`the test script has no reply for call ${String(requests.length)}`);
    try {
      for (const content of tokens) {
        await new Promise((resolve) => setTimeout(resolve, gapMs));
        if (request.signal?.aborted) {
          yield { type: "finish", reason: "aborted", provider: "google", model: "gemini-test" };
          return;
        }
        tokenAt.push(Date.now());
        yield { type: "token", content, provider: "google", model: "gemini-test" };
      }
      yield { type: "usage", provider: "google", model: "gemini-test", modelTier: "sonnet", inputTokens: 100, outputTokens: 20, cachedInputTokens: 0, costCents: 1, estimated: false, priced_as_default: false, unpriced: false };
      yield { type: "finish", reason: "stop", provider: "google", model: "gemini-test" };
    } finally {
      closed += 1;
    }
  }
  const gateway = { stream, complete: (request: GatewayStreamRequest) => collectCompletion(stream(request)) };
  return { gateway, requests, tokenAt, closed: () => closed };
}

async function timed(events: AsyncIterable<OrcEvent>): Promise<Array<{ readonly event: OrcEvent; readonly at: number }>> {
  const out: Array<{ event: OrcEvent; at: number }> = [];
  for await (const event of events) out.push({ event, at: Date.now() });
  return out;
}

/** 50 tokens: the envelope's opening, 48 words, its close. */
const WORDS = Array.from({ length: 48 }, (_, i) => `w${String(i + 1)}`);
const STREAMED_ANSWER = WORDS.join(" ");
const ENVELOPE_TOKENS = ['{"answer": "', ...WORDS.map((word, i) => (i === 0 ? word : ` ${word}`)), '"}'];

describe("[C13] the answer streams: step_delta frames while the model writes", () => {
  it("50 tokens 100 ms apart: the first answer text is a frame within 300 ms of the first token, long before step_end, never the envelope", async () => {
    const fake = streamingGateway([ENVELOPE_TOKENS]);
    const responseFormat = { type: "json_object" as const };
    const runner = createSoloRunner({ gateway: fake.gateway, tools: { adapters: [] }, session: memorySession(), memory: fakeMemory().memory, meter: fakeMeter({ centsPerCall: 2 }), now: FIXED_NOW, newId: sequentialIds(), config: { responseFormat } });
    const frames = await timed(runner.run({ objective: "Say the words." }));
    const deltas = frames.filter((f) => f.event.kind === "step_delta");
    const stepEnd = frames.find((f) => f.event.kind === "step_end");

    expect(deltas.length).toBeGreaterThan(40);
    expect(deltas[0]!.at - fake.tokenAt[0]!).toBeLessThan(300);
    expect(stepEnd!.at - deltas[0]!.at).toBeGreaterThan(4_000);
    expect(deltas.map((f) => f.event.detail).join("")).toBe(STREAMED_ANSWER);
    for (const f of deltas) {
      expect(f.event.detail).not.toContain('"answer"');
      expect(f.event.detail).not.toContain("{");
      expect(f.event.step).toMatchObject({ id: "solo_1-trent", agentRole: "trent", status: "running" });
    }
    // Everything after the deltas is the frame sequence a non-streamed turn emits, answer included.
    expect(kinds(frames.map((f) => f.event)).filter((kind) => kind !== "step_delta")).toEqual(["run_start", "step_start", "step_output", "step_end", "run_done"]);
    expect(frames.find((f) => f.event.kind === "step_output")?.event.step?.output).toBe(STREAMED_ANSWER);
    expect(frames.at(-1)?.event.run).toMatchObject({ status: "completed", summary: STREAMED_ANSWER });
    expect(stepEnd?.event.step).toMatchObject({ status: "completed", costCents: 2, tokens: 120, model: "gemini-test" });
  }, 20_000);

  it("text protocol: the words beside a call stream and are the step_note after it; the call itself never streams", async () => {
    const files = fakeAdapter({ name: "file_ops", tools: ["read_file"] });
    const call = ["Let me ", "look.\n<tool", '_call>\n{"name": "read_file", ', '"arguments": {"path": "a.md"}}\n</tool_call>'];
    const fake = streamingGateway([call, ["Five ", "working ", "days."]], 5);
    const runner = createSoloRunner({ gateway: fake.gateway, tools: { adapters: [files] }, session: memorySession(), memory: fakeMemory().memory, meter: fakeMeter(), now: FIXED_NOW, newId: sequentialIds() });
    const events = (await timed(runner.run({ objective: "Read a.md" }))).map((f) => f.event);

    expect(kinds(events)).toEqual(["run_start", "step_start", "step_delta", "step_delta", "step_note", "step_output", "step_delta", "step_delta", "step_delta", "step_output", "step_end", "run_done"]);
    expect(events.slice(2, 4).map((e) => e.detail).join("")).toBe("Let me look.");
    expect(events[4]?.detail).toBe("Let me look.");
    expect(events.slice(6, 9).map((e) => e.detail).join("")).toBe("Five working days.");
    expect(events[9]?.step?.output).toBe("Five working days.");
    expect(files.calls.map((c) => c.action)).toEqual(['read_file {"path":"a.md"}']);
  });

  it("an abort mid-stream closes the model's stream and cancels the run", async () => {
    const fake = streamingGateway([ENVELOPE_TOKENS], 20);
    const runner = createSoloRunner({ gateway: fake.gateway, tools: { adapters: [] }, session: memorySession(), memory: fakeMemory().memory, meter: fakeMeter(), now: FIXED_NOW, newId: sequentialIds(), config: { responseFormat: { type: "json_object" } } });
    const controller = new AbortController();
    const events: OrcEvent[] = [];
    for await (const event of runner.run({ objective: "Say the words.", signal: controller.signal })) {
      events.push(event);
      if (event.kind === "step_delta" && events.filter((e) => e.kind === "step_delta").length === 3) controller.abort(new Error("stopped by the test"));
    }
    expect(kinds(events).filter((kind) => kind !== "step_delta")).toEqual(["run_start", "step_start", "step_end", "run_cancelled"]);
    expect(fake.tokenAt.length).toBeLessThan(ENVELOPE_TOKENS.length);
    expect(fake.closed()).toBe(1);
  });
});
