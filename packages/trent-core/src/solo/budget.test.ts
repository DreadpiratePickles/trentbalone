/**
 * [S1.1] C2: an in-run context budget. A tool result reaches the model capped at
 * `agent.solo.max_tool_result_chars` (default 8,000) with the cut named, in the run and when the
 * session is replayed; the full record stays on the frame and in the session. A request whose
 * estimated prompt plus the output reservation exceeds the model's window is refused BEFORE it is
 * sent (a local server would cut it silently, local-models F1), with a verdict naming the sizes.
 */
import { describe, expect, it } from "vitest";
import { verdictOf } from "../orchestrator/verdict.js";
import { FIXED_NOW, collect, fakeAdapter, fakeMemory, fakeMeter, kinds, memorySession, scriptedGateway, sequentialIds, toolCall, toolCallsOf, transcriptOf, type ScriptStep } from "./fakes.test-helpers.js";
import { createSoloRunner } from "./runner.js";
import { DEFAULT_SOLO_MAX_TOOL_RESULT_CHARS, type SoloConfig, type SoloMessage } from "./types.js";

const BIG = "x".repeat(20_000);

function setup(script: readonly ScriptStep[], config: SoloConfig = {}, history: SoloMessage[] = []) {
  const files = fakeAdapter({ name: "file_ops", tools: ["read_file"], result: () => ({ status: "completed", summary: BIG }) });
  const gateway = scriptedGateway(script);
  const session = memorySession(history);
  const runner = createSoloRunner({ gateway, tools: { adapters: [files] }, session, memory: fakeMemory([]).memory, meter: fakeMeter(), now: FIXED_NOW, newId: sequentialIds(), config });
  return { gateway, session, runner, files };
}

describe("[S1.1] C2: tool results are capped for the model", () => {
  it("defaults to 8,000 characters, names the cut, and keeps the full record on the frame and in the session", async () => {
    expect(DEFAULT_SOLO_MAX_TOOL_RESULT_CHARS).toBe(8_000);
    const { runner, gateway, session } = setup([toolCall('read_file {"path": "big.log"}'), "It is a big log."]);
    const events = await collect(runner.run({ objective: "Read big.log" }));

    const told = transcriptOf(gateway.requests[1]).at(-1) ?? "";
    expect(told).toContain("x".repeat(8_000));
    expect(told).not.toContain("x".repeat(8_001));
    expect(told).toContain("[truncated: this result is 20,000 characters; the first 8,000 are shown (agent.solo.max_tool_result_chars)]");
    expect(toolCallsOf(events[2])[0]?.summary).toHaveLength(20_000);
    expect(session.messages.find((m) => m.role === "tool")?.record?.summary).toHaveLength(20_000);
  });

  it("takes the cap from config, and applies it when the session is replayed next turn", async () => {
    const { runner, gateway } = setup([toolCall('read_file {"path": "big.log"}'), "Big.", "Still big."], { maxToolResultChars: 100 });
    await collect(runner.run({ objective: "Read big.log" }));
    expect(transcriptOf(gateway.requests[1]).at(-1)).toContain("the first 100 are shown");

    await collect(runner.run({ objective: "And again?" }));
    const replayed = transcriptOf(gateway.requests[2]).join("\n");
    expect(replayed).toContain("x".repeat(100));
    expect(replayed).not.toContain("x".repeat(101));
  });
});

describe("[S1.1] C2: a prompt over the window is never sent", () => {
  it("refuses before the first call when history plus the reservation exceed the window, naming the sizes", async () => {
    const history: SoloMessage[] = [
      { role: "user", content: "y".repeat(4_000) },
      { role: "assistant", content: "Noted." },
    ];
    const { runner, gateway } = setup(["unused"], { contextWindowTokens: 1_000, maxTokens: 200 }, history);
    const events = await collect(runner.run({ objective: "Continue" }));

    expect(gateway.requests).toHaveLength(0);
    expect(kinds(events)).toEqual(["run_start", "step_start", "step_end", "run_failed"]);
    const summary = verdictOf(events.at(-1))?.summary ?? "";
    expect(summary).toMatch(/the prompt \(~[\d,]+ tokens, estimated at 4 characters a token\) plus the 200-token output reservation needs [\d,]+ tokens, but the model's window is 1,000 tokens; it was not sent/);
    expect(summary).toMatch(/system prefix [\d,]+ chars, conversation [\d,]+ chars in \d+ messages, largest message 4,[\d]{3} chars/);
  });

  it("refuses the call a big result would overflow, after the call that fit", async () => {
    const { runner, gateway, files } = setup([toolCall('read_file {"path": "big.log"}'), "unused"], { contextWindowTokens: 3_000, maxTokens: 500, maxToolResultChars: 20_000 });
    const events = await collect(runner.run({ objective: "Read big.log" }));
    expect(gateway.requests).toHaveLength(1);
    expect(files.calls).toHaveLength(1);
    expect(kinds(events).at(-1)).toBe("run_failed");
    expect(verdictOf(events.at(-1))?.summary).toContain("the model's window is 3,000 tokens");
  });

  it("uses a 4,096-token reservation when no max_tokens is set, and sends a prompt that fits", async () => {
    const { runner, gateway } = setup(["Hi."], { contextWindowTokens: 32_768 });
    expect(kinds(await collect(runner.run({ objective: "Hello" }))).at(-1)).toBe("run_done");
    expect(gateway.requests).toHaveLength(1);

    const tight = setup(["unused"], { contextWindowTokens: 4_100 });
    const events = await collect(tight.runner.run({ objective: "Hello" }));
    expect(verdictOf(events.at(-1))?.summary).toContain("plus the 4,096-token output reservation");
  });
});
