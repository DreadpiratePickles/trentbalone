/**
 * [L0-2] RED for audit G17: a seat prompt that does not fit the local model's window is refused
 * BEFORE it is sent, with the sizes and the tier to trim, instead of being cut silently by the server
 * (Ollama "silently discards context that exceeds the window": research F1).
 *
 * The pure arithmetic first, then the hook end to end against a fake Ollama `/api/ps` on 127.0.0.1.
 */
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearLocalProbeCache } from "../model-gateway/local-probe.js";
import { ALIAS_ENV, applyProviderAliasEnv } from "../model-gateway/providers.js";
import { createMemoryAdapter } from "../tools/memory/index.js";
import { createFleetMemoryHook } from "./orchestrator-hook.js";
import { evaluatePromptBudget, promptBudgetMessage } from "./prompt-budget.js";
import { InMemoryFleetSource } from "./source.js";

describe("evaluatePromptBudget", () => {
  it("a 4K window refuses a 6K prompt", () => {
    const verdict = evaluatePromptBudget({ promptTokens: 6_000, reserveTokens: 8_192, windowTokens: 4_096 });
    expect(verdict).toMatchObject({ fits: false, needTokens: 14_192, windowTokens: 4_096 });
  });

  it("a 64K window accepts it, with the headroom stated", () => {
    const verdict = evaluatePromptBudget({ promptTokens: 6_000, reserveTokens: 8_192, windowTokens: 65_536 });
    expect(verdict).toMatchObject({ fits: true, needTokens: 14_192, headroomTokens: 51_344 });
  });
});

describe("promptBudgetMessage", () => {
  const verdict = evaluatePromptBudget({ promptTokens: 6_000, reserveTokens: 8_192, windowTokens: 4_096 });
  const where = { seat: "engineer", model: "qwen3.5:9b", alias: "ollama" as const, windowSource: "ollama /api/ps" };

  it("names the sizes, the window's source and the setting that moves each", () => {
    const message = promptBudgetMessage(verdict, { ...where, parts: { seatPromptChars: 4_000, stableChars: 2_000, contextChars: 18_000, volatileChars: 0, contextBlocks: [["fleet-recall", 15_000], ["brain-recall", 3_000]] } });
    expect(message).toMatch(/engineer/);
    expect(message).toMatch(/~6,000 tokens/);
    expect(message).toMatch(/8,192-token/);
    expect(message).toMatch(/4,096-token context window/);
    expect(message).toMatch(/ollama \/api\/ps/);
    expect(message).toMatch(/OLLAMA_CONTEXT_LENGTH/);
    expect(message).toMatch(/context tier.*fleet-recall 15,000 chars.*context\.ceiling_chars/);
  });

  it("names the stable tier when that is the large one, which the ceiling never trims", () => {
    const message = promptBudgetMessage(verdict, { ...where, parts: { seatPromptChars: 2_000, stableChars: 20_000, contextChars: 1_000, volatileChars: 1_000, contextBlocks: [] } });
    expect(message).toMatch(/stable tier/);
    expect(message).toMatch(/memory/);
  });
});

// ── the hook, end to end ───────────────────────────────────────────────────────

const ENV_KEYS = [ALIAS_ENV, "OLLAMA_BASE_URL", "OPENAI_BASE_URL", "OPENAI_API_KEY", "MODEL_PREFERRED_PROVIDER", "OPENAI_MODEL_FAST", "OPENAI_MODEL_DEFAULT", "OPENAI_MODEL_STRONG", "OPENAI_MODEL_CRITIC", "OPENAI_MAX_TOKENS_JSON", "TRENT_LOCAL_CONTEXT_TOKENS"];
const saved = new Map<string, string | undefined>();
let profileDir = "";
let server: http.Server | undefined;
let probes: string[] = [];

async function fakeOllama(windowTokens: number): Promise<string> {
  probes = [];
  server = http.createServer((req, res) => {
    probes.push(`${req.method} ${req.url}`);
    req.resume();
    if (req.url === "/api/ps") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: "qwen3.5:9b", model: "qwen3.5:9b", context_length: windowTokens }] }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  clearLocalProbeCache();
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-prompt-budget-"));
  fs.mkdirSync(path.join(profileDir, "memories"), { recursive: true });
});

afterEach(async () => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(profileDir, { recursive: true, force: true });
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

/** A seat call whose own prompt is ~6K tokens (24,000 chars), run through the real hook. */
async function seatCall(): Promise<{ result: unknown; called: boolean }> {
  const hook = createFleetMemoryHook({ source: new InMemoryFleetSource(), memory: createMemoryAdapter({ profileDir }), brain: false });
  hook.runStarted({ runId: "run_budget", companyId: "co_budget", objective: "Say ready" });
  let called = false;
  const wrapped = hook.wrapSeatModel(async (_input: { companyId?: string; subtask: { id: string; seat: string; objective?: string }; systemPrompt?: string; dynamicPrompt?: string }) => {
    called = true;
    return "sent";
  });
  const input = { companyId: "co_budget", subtask: { id: "s1", seat: "engineer", objective: "Say ready" }, systemPrompt: "x".repeat(24_000), dynamicPrompt: "" };
  const result = await wrapped(input).catch((error: unknown) => error);
  return { result, called };
}

describe("the fleet hook asks the budget before a seat call leaves", () => {
  it("a 4K local window: refused before sending, naming the window", async () => {
    process.env.OLLAMA_BASE_URL = await fakeOllama(4_096);
    applyProviderAliasEnv("ollama", "qwen3.5:9b");
    const { result, called } = await seatCall();
    expect(called).toBe(false);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/4,096-token context window/);
    expect(probes).toContain("GET /api/ps");
  });

  it("a 64K local window: sent", async () => {
    process.env.OLLAMA_BASE_URL = await fakeOllama(65_536);
    applyProviderAliasEnv("ollama", "qwen3.5:9b");
    expect(await seatCall()).toEqual({ result: "sent", called: true });
  });

  it("a hosted provider: sent, and no local server is asked anything", async () => {
    process.env.OLLAMA_BASE_URL = await fakeOllama(4_096);
    expect(await seatCall()).toEqual({ result: "sent", called: true });
    expect(probes).toEqual([]);
  });
});
