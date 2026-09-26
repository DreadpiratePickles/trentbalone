/**
 * [C12] The cap warns before it stops (council C12; Hermes `agent/turn_iteration_prep.py`
 * `_maybe_inject_iteration_budget_warning`, `agent/iteration_budget.py`).
 *
 * `agent.solo.max_tool_calls` stopped a run with no warning. Now, once the run has made 80 percent of its calls, the
 * next model request carries ONE system note: "N tool calls left; wrap up". Once per run: later requests carry the
 * same note as history, never a second one. It rides the tail of the last user message (the tool results), never a
 * system message: the Anthropic client joins every system message into the one cached system block
 * (`model-gateway/anthropic-client.ts` `systemBlocks`), so a system message mid-run would move the frozen prefix.
 */
import { describe, expect, it } from "vitest";
import { FIXED_NOW, collect, fakeAdapter, fakeMemory, fakeMeter, kinds, memorySession, scriptedGateway, sequentialIds, toolCall } from "./fakes.test-helpers.js";
import { createSoloRunner } from "./runner.js";

const NOTE = /\d+ tool calls? left; wrap up/g;
const read = (i: number): string => toolCall(`read_file {"path": "${String(i)}.md"}`);

function setup(calls: number, maxToolCalls?: number) {
  const files = fakeAdapter({ name: "file_ops", tools: ["read_file"] });
  const gateway = scriptedGateway([...Array.from({ length: calls }, (_, i) => read(i + 1)), "Done with what I have."]);
  const runner = createSoloRunner({ gateway, tools: { adapters: [files] }, session: memorySession(), memory: fakeMemory([]).memory, meter: fakeMeter(), now: FIXED_NOW, newId: sequentialIds(), ...(maxToolCalls === undefined ? {} : { config: { maxToolCalls } }) });
  return { gateway, runner };
}

const notesIn = (request: { messages: ReadonlyArray<{ content: string }> } | undefined): string[] => (request?.messages ?? []).flatMap((message) => message.content.match(NOTE) ?? []);

describe("[C12] the wrap-up notice at 80 percent of agent.solo.max_tool_calls", () => {
  it("reaches the model once, on the first request after the eighth of ten calls, and names the calls left", async () => {
    const { gateway, runner } = setup(9, 10);
    const events = await collect(runner.run({ objective: "Read the notes." }));

    expect(kinds(events).at(-1)).toBe("run_done");
    expect(gateway.requests).toHaveLength(10);
    // Requests 1-8 went out after 0-7 calls: no note.
    for (const request of gateway.requests.slice(0, 8)) expect(notesIn(request)).toEqual([]);
    // Request 9 went out after 8 calls: the note, once, at the end of its last message.
    expect(notesIn(gateway.requests[8])).toEqual(["2 tool calls left; wrap up"]);
    expect(gateway.requests[8]?.messages.at(-1)?.content).toMatch(/2 tool calls left; wrap up[^\n]*$/);
    // Request 10 carries it as history, never twice; no request carries a second system message.
    expect(notesIn(gateway.requests[9])).toEqual(["2 tool calls left; wrap up"]);
    for (const request of gateway.requests) expect(request.messages.filter((message) => message.role === "system")).toHaveLength(1);
  });

  it("the default cap of 25 warns after 20 calls, and a run that stays under 80 percent is never told", async () => {
    const long = setup(21);
    await collect(long.runner.run({ objective: "Read everything." }));
    expect(long.gateway.requests.slice(0, 20).flatMap(notesIn)).toEqual([]);
    expect(notesIn(long.gateway.requests[20])).toEqual(["5 tool calls left; wrap up"]);

    const short = setup(7, 10);
    await collect(short.runner.run({ objective: "Read a few." }));
    expect(short.gateway.requests.flatMap(notesIn)).toEqual([]);
  });
});
