/**
 * The Local Model check against a fake runtime (audit G8 and G17; local-models D1-D3). Every request
 * goes through the doctor's fetch seam into `local-runtime.test-helpers.ts`; nothing opens a socket
 * and nothing reaches a hosted provider.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigManager } from "../../config/ConfigManager.js";
import { SEAT_JSON_INSTRUCTION } from "../../orchestrator/seat-gateway-port.js";
import { DEFAULT_CHECKS } from "../DoctorRunner.js";
import type { CheckResult, DoctorContext, FetchLike } from "../types.js";
import { CONTEXT_FLOOR_TOKENS, TTFT_PROMPT_TOKENS, checkLocalModel, createLocalModelCheck } from "./local-model.js";
import { SMOKE_CASES } from "./local-smoke.js";
import { fakeRuntime, wellBehavedReply, type FakeRuntimeOptions } from "./local-runtime.test-helpers.js";

const OLLAMA = "http://127.0.0.1:11434/v1";
const LLAMA = "http://127.0.0.1:8080/v1";
const LMSTUDIO = "http://127.0.0.1:1234/v1";

let tempDir: string;
let configManager: ConfigManager;

function useProfile(provider: string, model: string): void {
  configManager.saveConfig({ ...configManager.loadConfig(), provider: provider as never, model });
}

const context = (over: Partial<DoctorContext> = {}): DoctorContext => ({
  baseDir: tempDir,
  profile: "default",
  configManager,
  probeTimeoutMs: 1000,
  env: { OLLAMA_BASE_URL: OLLAMA },
  ...over,
});

/** Short deadlines so a slow case is a test of the deadline, not of the test runner's patience. */
const quick = createLocalModelCheck({ smokeCaseTimeoutMs: 5_000, ttftWarnMs: 5_000 });

async function runAgainst(baseUrl: string, options: FakeRuntimeOptions, over: Partial<DoctorContext> = {}, check = quick): Promise<{ result: CheckResult; runtime: ReturnType<typeof fakeRuntime> }> {
  const runtime = fakeRuntime(baseUrl, options);
  const result = await check.run(context({ fetchImpl: runtime.fetchImpl, ...over }));
  return { result, runtime };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-local-model-"));
  configManager = new ConfigManager({ baseDir: tempDir });
  configManager.ensureDirs();
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("Local Model check", () => {
  it("is a default check with a category of its own and a budget longer than the 60 s first-token limit", () => {
    const registered = DEFAULT_CHECKS.find((check) => check.id === "check_local_model");
    expect(registered).toBe(checkLocalModel);
    expect(checkLocalModel.category).toBe("Local Model");
    expect(checkLocalModel.timeoutMs).toBeGreaterThan(60_000);
  });

  it("skips a hosted provider with a reason and sends nothing", async () => {
    useProfile("google", "gemini-3.5-flash-lite");
    const fetchImpl: FetchLike = async () => {
      throw new Error("must not be called");
    };
    const result = await checkLocalModel.run(context({ fetchImpl }));
    expect(result.status).toBe("skip");
    expect(result.message).toContain("google");
    expect(result.message).toMatch(/hosted/);
  });

  it("fails naming the URL when nothing answers there, and contacts no other host", async () => {
    useProfile("ollama", "qwen3:4b");
    const urls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      urls.push(url);
      throw new TypeError("fetch failed");
    };
    const result = await checkLocalModel.run(context({ fetchImpl, env: { OLLAMA_BASE_URL: "http://127.0.0.1:9/v1" } }));
    expect(result.status).toBe("fail");
    expect(result.message).toContain("http://127.0.0.1:9/v1");
    expect(result.fixHint).toContain("ollama serve");
    expect(result.fixHint).toContain("OLLAMA_BASE_URL");
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((url) => url.startsWith("http://127.0.0.1:9/"))).toBe(true);
  });

  it("fails with the exact pull command when the configured model is not pulled, and sends it no prompt", async () => {
    useProfile("ollama", "qwen3:4b");
    const { result, runtime } = await runAgainst(OLLAMA, { kind: "ollama", models: ["qwen3.5:9b"], loadedContext: 32768 });
    expect(result.status).toBe("fail");
    expect(result.message).toContain('"qwen3:4b"');
    expect(result.message).toContain("Ollama 0.32.9");
    expect(result.fixHint).toContain("`ollama pull qwen3:4b`");
    expect(runtime.chatCalls()).toEqual([]);
  });

  it("passes a runtime that keeps the contract: version, model, context, smoke 5/5 through the gateway, first token", async () => {
    useProfile("ollama", "llama3.2");
    const { result, runtime } = await runAgainst(OLLAMA, { kind: "ollama", models: ["llama3.2:latest"], loadedContext: 32768, longPromptTokens: 4102 });
    expect(result.status).toBe("ok");
    expect(result.message).toContain("Ollama 0.32.9");
    expect(result.message).toContain(OLLAMA);
    expect(result.message).toContain("llama3.2");
    expect(result.message).toContain("32768");
    expect(result.message).toContain("5/5");
    expect(result.message).toMatch(/first token after [\d.]+ s at 4102 prompt tokens/);
    expect(result.details).toMatchObject({ runtime: "ollama", version: "0.32.9", smoke: { score: 5, total: 5 }, ttft: { promptTokens: 4102, timedOut: false } });

    const chats = runtime.chatCalls();
    expect(chats).toHaveLength(SMOKE_CASES.length + 1);
    const smoke = chats.filter((chat) => chat.caseId !== undefined);
    expect(smoke.map((chat) => chat.caseId)).toEqual(SMOKE_CASES.map((c) => c.id));
    for (const chat of smoke) {
      // The configured model, streamed with usage, under the seat port's own JSON instruction.
      expect(chat.model).toBe("llama3.2");
      expect(chat.body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
      expect(chat.system).toContain(SEAT_JSON_INSTRUCTION);
      expect(chat.system).toContain('"toolCall"');
    }
    const ttft = chats.find((chat) => chat.caseId === undefined)!;
    expect(ttft.user.length).toBeGreaterThanOrEqual(TTFT_PROMPT_TOKENS * 4);
  });

  it("uses a fresh prefix for every first-token probe, so a warm prompt cache cannot flatter it", async () => {
    useProfile("ollama", "qwen3:4b");
    const first = await runAgainst(OLLAMA, { kind: "ollama", models: ["qwen3:4b"], loadedContext: 32768 });
    const second = await runAgainst(OLLAMA, { kind: "ollama", models: ["qwen3:4b"], loadedContext: 32768 });
    const head = (r: typeof first): string => r.runtime.chatCalls().find((c) => c.caseId === undefined)!.user.slice(0, 80);
    expect(head(first)).not.toBe(head(second));
  });

  it("warns under 32768 tokens of context and names OLLAMA_CONTEXT_LENGTH, num_ctx and the docs page", async () => {
    useProfile("ollama", "qwen3:4b");
    const { result } = await runAgainst(OLLAMA, { kind: "ollama", models: ["qwen3:4b"], loadedContext: 4096 });
    expect(CONTEXT_FLOOR_TOKENS).toBe(32768);
    expect(result.status).toBe("warn");
    expect(result.message).toContain("4096");
    expect(result.fixHint).toContain("OLLAMA_CONTEXT_LENGTH");
    expect(result.fixHint).toContain("num_ctx");
    expect(result.fixHint).toContain("https://docs.ollama.com/context-length");
    expect(result.details).toMatchObject({ context: { tokens: 4096 } });
  });

  it("reads the Modelfile num_ctx when the model is not loaded", async () => {
    useProfile("ollama", "qwen3:4b");
    const { result } = await runAgainst(OLLAMA, { kind: "ollama", models: ["qwen3:4b"], numCtx: 65536 });
    expect(result.details).toMatchObject({ context: { tokens: 65536 } });
    expect(result.message).toContain("65536");
    expect(result.message).toMatch(/num_ctx/);
  });

  it("scores the smoke N/5 and names each failing case", async () => {
    useProfile("ollama", "qwen3:4b");
    // A model that calls read_file whatever it is asked.
    const alwaysReads = (): string => wellBehavedReply("call");
    const { result } = await runAgainst(OLLAMA, { kind: "ollama", models: ["qwen3:4b"], loadedContext: 32768, reply: alwaysReads });
    expect(result.status).toBe("warn");
    expect(result.message).toContain("2/5");
    for (const id of ["abstain", "escaping", "required"]) expect(result.message).toContain(id);
    const failed = (result.details?.smoke as { cases: { id: string; pass: boolean }[] }).cases.filter((c) => !c.pass).map((c) => c.id);
    expect(failed).toEqual(["abstain", "escaping", "required"]);
    expect(result.fixHint).toBeTruthy();
  });

  it("fails the unknown-tool case, naming the tool, when the model calls one it was not offered", async () => {
    useProfile("ollama", "qwen3:4b");
    const reply = (request: { caseId?: string }): string =>
      request.caseId === "unknown-tool"
        ? JSON.stringify({ toolCall: { name: "email", action: 'send_email {"to":"alex@example.com"}' }, summary: null })
        : wellBehavedReply(request.caseId as never);
    const { result } = await runAgainst(OLLAMA, { kind: "ollama", models: ["qwen3:4b"], loadedContext: 32768, reply });
    expect(result.message).toContain("4/5");
    expect(result.message).toContain("unknown-tool");
    expect(result.message).toContain("send_email");
  });

  it("fails the escaping case when the quotes or the newline do not survive the arguments", async () => {
    useProfile("ollama", "qwen3:4b");
    const reply = (request: { caseId?: string }): string =>
      request.caseId === "escaping"
        ? JSON.stringify({ toolCall: { name: "file_ops", action: 'write_file {"path":"quote.txt","content":"She said yes. Then she left."}' }, summary: null })
        : wellBehavedReply(request.caseId as never);
    const { result } = await runAgainst(OLLAMA, { kind: "ollama", models: ["qwen3:4b"], loadedContext: 32768, reply });
    expect(result.message).toContain("4/5");
    expect(result.message).toContain("escaping");
  });

  it("fails outright when the model never produces the JSON contract", async () => {
    useProfile("ollama", "qwen3:4b");
    const { result } = await runAgainst(OLLAMA, { kind: "ollama", models: ["qwen3:4b"], loadedContext: 32768, reply: () => "Sure, I can help with that." });
    expect(result.status).toBe("fail");
    expect(result.message).toContain("0/5");
    expect(result.message).toMatch(/not JSON/);
  });

  it("warns when no first token arrives within the limit at a 4K-token prompt", async () => {
    useProfile("ollama", "qwen3:4b");
    const check = createLocalModelCheck({ smokeCaseTimeoutMs: 5_000, ttftWarnMs: 150 });
    const { result } = await runAgainst(OLLAMA, { kind: "ollama", models: ["qwen3:4b"], loadedContext: 32768, firstTokenDelayMs: 1_000 }, {}, check);
    expect(result.status).toBe("warn");
    expect(result.message).toMatch(/no first token within 0\.15 s/);
    expect(result.details).toMatchObject({ ttft: { timedOut: true } });
    expect(result.fixHint).toMatch(/first token/i);
  });

  it("counts a streamed reasoning delta as the first token", async () => {
    useProfile("ollama", "qwen3:4b");
    const { result } = await runAgainst(OLLAMA, { kind: "ollama", models: ["qwen3:4b"], loadedContext: 32768, reasoning: "Thinking about it." });
    expect(result.status).toBe("ok");
    expect(result.details).toMatchObject({ ttft: { timedOut: false } });
  });

  it("sends no prompt to an Ollama cloud model: its prompts would leave this machine", async () => {
    useProfile("ollama", "nemotron-3-ultra:cloud");
    const { result, runtime } = await runAgainst(OLLAMA, { kind: "ollama", models: ["qwen3:4b"], cloud: ["nemotron-3-ultra:cloud"] });
    expect(result.status).toBe("warn");
    expect(result.message).toMatch(/cloud/);
    expect(runtime.chatCalls()).toEqual([]);
  });

  it("identifies llama.cpp behind a base URL and reads n_ctx and slots from /props", async () => {
    useProfile("lmstudio", "qwen3-4b");
    const { result } = await runAgainst(LLAMA, { kind: "llama.cpp", models: ["qwen3-4b"], loadedContext: 8192, slots: 4 }, { env: { LMSTUDIO_BASE_URL: LLAMA } });
    expect(result.status).toBe("warn");
    expect(result.message).toContain("llama.cpp");
    expect(result.message).toContain("8192");
    expect(result.message).toContain("4 slots");
    expect(result.fixHint).toContain("-c");
    expect(result.details).toMatchObject({ runtime: "llama.cpp", slots: 4, smoke: { score: 5 } });
  });

  it("reads LM Studio's loaded context length and parallel predictions", async () => {
    useProfile("lmstudio", "qwen/qwen3-4b");
    const { result } = await runAgainst(LMSTUDIO, { kind: "lmstudio", models: ["qwen/qwen3-4b"], loadedContext: 65536, slots: 4 }, { env: { LMSTUDIO_BASE_URL: LMSTUDIO } });
    expect(result.status).toBe("ok");
    expect(result.message).toContain("LM Studio");
    expect(result.message).toContain("65536");
    expect(result.details).toMatchObject({ runtime: "lmstudio", slots: 4, context: { tokens: 65536 } });
  });
});
