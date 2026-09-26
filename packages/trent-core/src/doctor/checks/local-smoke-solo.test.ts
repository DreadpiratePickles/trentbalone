/**
 * [C11] The doctor's Local Model smoke on the SOLO format: L0-4's five cases (`local-smoke.ts`) sent the way
 * a solo turn is sent (the solo system prompt: persona, tool protocol, tool disclosure; the case as the
 * turn's opening after its context tier; the solo envelope as `response_format`), read back by the solo
 * parser, and scored by the SAME judge as the seat format. The score is reported beside the seat one; it
 * decides the default agent mode (council section 7, item 4). Against the fake runtime of
 * `local-runtime.test-helpers.ts`: nothing opens a socket.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigManager } from "../../config/ConfigManager.js";
import { SEAT_JSON_INSTRUCTION } from "../../orchestrator/seat-gateway-port.js";
import { SOLO_TOOL_PROTOCOL } from "../../solo/prompt.js";
import { SOLO_ENVELOPE_INSTRUCTION } from "../../solo/turn-settings.js";
import type { CheckResult, DoctorContext } from "../types.js";
import { createLocalModelCheck } from "./local-model.js";
import { SMOKE_CASES } from "./local-smoke.js";
import { readSoloTurn } from "./local-smoke-solo.js";
import { fakeRuntime, wellBehavedReply, wellBehavedSoloReply, type FakeChatRequest, type FakeRuntimeOptions } from "./local-runtime.test-helpers.js";

const OLLAMA = "http://127.0.0.1:11434/v1";
const quick = createLocalModelCheck({ smokeCaseTimeoutMs: 5_000, ttftWarnMs: 5_000 });
let tempDir: string;
let configManager: ConfigManager;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-local-smoke-solo-"));
  configManager = new ConfigManager({ baseDir: tempDir });
  configManager.ensureDirs();
});
afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function useProfile(model: string, mode?: "solo" | "fleet"): void {
  const config = configManager.loadConfig();
  configManager.saveConfig({ ...config, provider: "ollama" as never, model, ...(mode === undefined ? {} : { agent: { ...config.agent, mode } }) });
}

async function runAgainst(options: Omit<FakeRuntimeOptions, "kind" | "models">): Promise<{ result: CheckResult; runtime: ReturnType<typeof fakeRuntime> }> {
  const runtime = fakeRuntime(OLLAMA, { kind: "ollama", models: ["qwen3.5:9b"], loadedContext: 32768, ...options });
  const context: DoctorContext = { baseDir: tempDir, profile: "default", configManager, probeTimeoutMs: 1000, env: { OLLAMA_BASE_URL: OLLAMA }, fetchImpl: runtime.fetchImpl };
  return { result: await quick.run(context), runtime };
}

type Calls = { properties?: { tool_calls?: { items?: { properties?: { name?: { enum?: string[] } } } } } };
/** The call alternative of the envelope's `anyOf` (`soloEnvelopeFormat`), and its tool enum. */
const enumOf = (chat: FakeChatRequest): string[] => ((chat.body.response_format as { json_schema?: { schema?: { anyOf?: Calls[] } } }).json_schema?.schema?.anyOf?.[0]?.properties?.tool_calls?.items?.properties?.name?.enum ?? []);

describe("[C11] the Local Model check runs the five cases on the solo format too", () => {
  it("sends each case as a solo turn with the solo envelope as response_format, and reports the score beside the seat one", async () => {
    useProfile("qwen3.5:9b");
    const { result, runtime } = await runAgainst({});
    expect(result.details).toMatchObject({ smoke: { score: 5, total: 5 }, soloSmoke: { score: 5, total: 5 } });
    expect(result.message).toContain("tool-call smoke 5/5");
    expect(result.message).toContain("solo-format smoke 5/5");
    expect(result.status).toBe("ok");

    const solo = runtime.chatCalls().filter((chat) => chat.solo);
    expect(solo.map((chat) => chat.caseId)).toEqual(SMOKE_CASES.map((smoke) => smoke.id));
    for (const [i, chat] of solo.entries()) {
      const smoke = SMOKE_CASES[i]!;
      expect(chat.model).toBe("qwen3.5:9b");
      expect(chat.body).toMatchObject({ stream: true, response_format: { type: "json_schema", json_schema: { name: "solo_turn" } } });
      // The case's one tool and its toolset, as the solo parser resolves them.
      expect(enumOf(chat).sort()).toEqual(["file_ops", ...smoke.tools.map((tool) => tool.name)].sort());
      expect(chat.system).toContain(SOLO_TOOL_PROTOCOL);
      expect(chat.system.endsWith(`\n\n${SOLO_ENVELOPE_INSTRUCTION}`)).toBe(true);
      expect(chat.system).not.toContain(SEAT_JSON_INSTRUCTION);
      expect(chat.system).not.toContain("toolCall");
      expect(chat.user.endsWith(smoke.user)).toBe(true);
    }
  });

  it("scores the solo cases with the seat judge and names each failure", async () => {
    useProfile("qwen3.5:9b");
    // On the solo format this model reads notes/todo.md whatever it is asked.
    const reply = (request: FakeChatRequest): string => (request.solo ? wellBehavedSoloReply("call") : wellBehavedReply(request.caseId));
    const { result } = await runAgainst({ reply });
    expect(result.details).toMatchObject({ smoke: { score: 5 }, soloSmoke: { score: 2, total: 5 } });
    const failed = (result.details?.soloSmoke as { cases: { id: string; pass: boolean }[] }).cases.filter((c) => !c.pass).map((c) => c.id);
    expect(failed).toEqual(["abstain", "escaping", "required"]);
    // In those two cases read_file is not among the case's tools, so the parser names it as not offered.
    expect(result.message).toContain("solo-format smoke 2/5 (failed: abstain: called read_file when no tool was needed; escaping: called read_file, which was not offered; required: called read_file, which was not offered)");
  });

  it("a solo profile fails when the model never keeps the solo envelope; a fleet profile only reports it", async () => {
    const reply = (request: FakeChatRequest): string => (request.solo ? '{"toolCall": null, "summary": "done"}' : wellBehavedReply(request.caseId));
    useProfile("qwen3.5:9b", "solo");
    const solo = await runAgainst({ reply });
    expect(solo.result.details).toMatchObject({ smoke: { score: 5 }, soloSmoke: { score: 0 } });
    expect(solo.result.status).toBe("fail");
    expect(solo.result.fixHint).toMatch(/agent\.mode: solo/);

    useProfile("qwen3.5:9b", "fleet");
    const fleet = await runAgainst({ reply });
    expect(fleet.result.details).toMatchObject({ soloSmoke: { score: 0 } });
    expect(fleet.result.message).toContain("solo-format smoke 0/5");
    expect(fleet.result.status).toBe("ok");
  });
});

describe("[C11] readSoloTurn: a solo reply as the seat judge reads a turn", () => {
  const byId = (id: string) => SMOKE_CASES.find((smoke) => smoke.id === id)!;

  it("an envelope call is the call, its arguments an object; an answer is a finish", () => {
    expect(readSoloTurn(wellBehavedSoloReply("escaping"), byId("escaping"))).toEqual({ kind: "call", tool: "write_file", args: { path: "quote.txt", content: 'She said "yes".\nThen she left.' }, offered: true });
    expect(readSoloTurn('{"answer": "42"}', byId("abstain"))).toEqual({ kind: "finish", summary: "42" });
    expect(readSoloTurn("It is 42.", byId("abstain"))).toEqual({ kind: "finish", summary: "It is 42." });
    expect(readSoloTurn('<tool_call>\n{"name": "read_file", "arguments": {"path": "notes/todo.md"}}\n</tool_call>', byId("call"))).toMatchObject({ kind: "call", tool: "read_file", args: { path: "notes/todo.md" } });
  });

  it("a toolset named instead of its tool is the wrong tool; a tool that was not offered is not offered", () => {
    const call = byId("call");
    expect(call.judge(readSoloTurn('{"tool_calls": [{"name": "file_ops", "arguments": {"path": "notes/todo.md"}}]}', call) as never)).toBe("called file_ops instead of read_file");
    const unknown = byId("unknown-tool");
    const turn = readSoloTurn('{"tool_calls": [{"name": "send_email", "arguments": {"to": "alex@example.com"}}]}', unknown);
    expect(turn).toMatchObject({ kind: "call", tool: "send_email", offered: false });
    expect(unknown.judge(turn as never)).toBe("called send_email, which was not offered");
  });

  it("a reply that is neither the envelope nor text is invalid, with the parser's reason", () => {
    expect(readSoloTurn('{"toolCall": null, "summary": "done"}', byId("abstain"))).toMatchObject({ kind: "invalid", reason: expect.stringContaining('{"tool_calls"') });
    expect(readSoloTurn("", byId("abstain"))).toMatchObject({ kind: "invalid", reason: expect.stringContaining("empty") });
  });
});
