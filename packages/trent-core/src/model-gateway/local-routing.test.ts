/**
 * [L0-1] G4 (local-path audit 2026-09-26, security): routing is by PROVIDER, never by a substring of
 * the model id. The audit's probe of a pinned `mistral:7b` under `provider: ollama` left the machine:
 * `planAttempts` asked the app's `inferProviderFromModel`, which said "mistral", and the app's Mistral
 * client posted the prompt to api.mistral.ai with the local placeholder bearer. The same name was
 * refused as a seat ("mistral is not configured").
 *
 * WIRE tests: the real gateway, the app's real OpenAI-compatible client, two sockets on 127.0.0.1.
 * One is the local runtime. The other is a TRAP that stands in for every hosted endpoint the app can
 * be pointed at (`MISTRAL_BASE_URL`, `OPENROUTER_BASE_URL`, `GOOGLE_BASE_URL`), and `fetch` itself is
 * fenced to 127.0.0.1, so even the red run of this file cannot reach the internet. Anthropic's client
 * is a hard-coded URL but refuses before any request without `ANTHROPIC_API_KEY`, which is cleared.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyModelEnv } from "../orchestrator/model-env.js";
import { createSeatChatPort } from "../orchestrator/seat-gateway-port.js";
import { createModelGateway } from "./index.js";
import { ALIAS_ENV } from "./providers.js";
import type { GatewayMessage } from "./types.js";

interface Endpoint {
  readonly baseUrl: string;
  readonly models: string[];
  status: number;
  close(): Promise<void>;
}

/** An OpenAI-compatible `/chat/completions`: records the model asked for, answers SSE or JSON, or fails with `status`. */
async function startEndpoint(): Promise<Endpoint> {
  const models: string[] = [];
  const endpoint = { models, status: 200 } as { models: string[]; status: number };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      let body: { model?: string; stream?: boolean } = {};
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        body = {};
      }
      models.push(body.model ?? "");
      if (endpoint.status !== 200) {
        res.writeHead(endpoint.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `model "${body.model}" refused by this test endpoint` } }));
        return;
      }
      const content = '{"summary":"ok"}';
      if (body.stream !== true) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3 } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return Object.assign(endpoint, {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  });
}

/** Every variable a route reads. Cleared before each test so nothing live joins the chain. */
const ENV_KEYS = [
  ALIAS_ENV, "OLLAMA_BASE_URL", "OLLAMA_API_KEY", "LMSTUDIO_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL",
  "OPENAI_MODEL_FAST", "OPENAI_MODEL_DEFAULT", "OPENAI_MODEL_STRONG", "OPENAI_MODEL_CRITIC",
  "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "MISTRAL_API_KEY", "OPENROUTER_API_KEY",
  "MISTRAL_BASE_URL", "OPENROUTER_BASE_URL", "GOOGLE_BASE_URL",
  "MODEL_PREFERRED_PROVIDER", "MODEL_ALLOWED_PROVIDERS", "WORKBENCH_EXECUTOR_MODEL", "WORKBENCH_PLANNER_MODEL",
  "TRENT_MODEL_FALLBACK_ON_PIN", "TRENT_REASONING_EFFORT", "TRENT_MODEL_OVERRIDES",
];
const saved = new Map<string, string | undefined>();

const MESSAGES: GatewayMessage[] = [{ role: "user", content: "say ok" }];
const NO_SLEEP = { sleep: async () => undefined, random: () => 0 };

let local: Endpoint;
let trap: Endpoint;
let offMachine: string[];

beforeEach(async () => {
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  local = await startEndpoint();
  trap = await startEndpoint();
  process.env.OLLAMA_BASE_URL = local.baseUrl;
  for (const name of ["MISTRAL_BASE_URL", "OPENROUTER_BASE_URL", "GOOGLE_BASE_URL"]) process.env[name] = trap.baseUrl;
  offMachine = [];
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== "127.0.0.1") {
      offMachine.push(url.href);
      return Promise.reject(new Error(`this test never leaves the machine: ${url.host}`));
    }
    return realFetch(input, init);
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await local.close();
  await trap.close();
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

describe("[L0-1] under provider ollama no request leaves the machine, whatever the model is called", () => {
  it("a pinned mistral:7b reaches ONLY the local runtime", async () => {
    applyModelEnv({ provider: "ollama", model: "mistral:7b" });
    const gateway = await createModelGateway({ retry: NO_SLEEP });
    const completion = await gateway.complete({ role: "executor", model: "mistral:7b", messages: MESSAGES });
    expect(trap.models, "a hosted endpoint was called").toEqual([]);
    expect(local.models).toEqual(["mistral:7b"]);
    expect(offMachine).toEqual([]);
    expect(completion.model).toBe("mistral:7b");
    expect(completion.providerAlias).toBe("ollama");
  });

  it("accepts a seat whose model id names mistral, gemini or claude, and sends it to the local runtime only", async () => {
    applyModelEnv({ provider: "ollama", model: "mistral:7b" });
    const port = createSeatChatPort(await createModelGateway({ retry: NO_SLEEP }));
    const ids = ["mistral:7b", "gemini-distill:2b", "claude-local:8b"];
    for (const model of ids) {
      const reply = await port({ model, temperature: 0.2, response_format: { type: "json_object" }, messages: [{ role: "user", content: "seat turn" }] });
      expect(reply.choices[0]?.message.content, model).toBe('{"summary":"ok"}');
    }
    expect(local.models).toEqual(ids);
    expect(trap.models).toEqual([]);
    expect(offMachine).toEqual([]);
  });

  it("a local failure is the call's failure: the chain never falls back to a keyed hosted provider", async () => {
    // A surface that builds its own gateway (`trent heartbeat`, `trent improve`) resolves the alias in
    // the factory and never runs `applyModelEnv`, so the provider policy alone must hold the line.
    process.env.GEMINI_API_KEY = "not-a-real-key";
    process.env.MISTRAL_API_KEY = "not-a-real-key";
    local.status = 400;
    const gateway = await createModelGateway({ preferredProvider: "ollama" as unknown as "openai", models: { executor: "qwen3:4b" }, retry: NO_SLEEP });
    const outcome = await gateway.complete({ role: "executor", messages: MESSAGES }).then(() => "answered", () => "failed");
    expect(trap.models, "the call fell back to a hosted provider").toEqual([]);
    expect(outcome).toBe("failed");
    expect(local.models).toEqual(["qwen3:4b"]);
    expect(offMachine).toEqual([]);
  });
});
