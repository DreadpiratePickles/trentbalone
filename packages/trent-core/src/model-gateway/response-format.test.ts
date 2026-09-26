/**
 * [L1] Constrained output: a request's `responseFormat` reaches the provider as the OpenAI-compatible
 * `response_format`, verbatim where the provider documents a JSON schema, as plain JSON mode where it
 * documents only that, and not at all where the route cannot carry it.
 *
 * The wire shape is one for the four local runtimes, read from each one's source or docs
 * (`response-format.ts` header). Offline: every response is a fixture handed to the gateway's
 * `fetchImpl` seam and every base URL is `127.0.0.1:9` (discard), so nothing leaves the machine.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildCompatChatBody } from "./openai-compat.js";
import { createModelGateway } from "./index.js";
import { clearLocalProbeCache } from "./local-probe.js";
import { ALIAS_ENV, PROVIDER_ALIAS_ROUTES, applyProviderAliasEnv, type ProviderAlias } from "./providers.js";
import { RESPONSE_FORMAT_SUPPORT, responseFormatFor } from "./response-format.js";
import type { GatewayResponseFormat, ProviderStreamFn } from "./types.js";

const DEAD = "http://127.0.0.1:9/v1";

const ENV_KEYS = [
  ALIAS_ENV, "OLLAMA_BASE_URL", "LMSTUDIO_BASE_URL", "DEEPSEEK_BASE_URL", "GROQ_BASE_URL", "OLLAMA_API_KEY",
  "LMSTUDIO_API_KEY", "DEEPSEEK_API_KEY", "GROQ_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL", "MODEL_PREFERRED_PROVIDER",
  "MODEL_ALLOWED_PROVIDERS", "OPENAI_MODEL_FAST", "OPENAI_MODEL_DEFAULT", "OPENAI_MODEL_STRONG", "OPENAI_MODEL_CRITIC",
  "WORKBENCH_EXECUTOR_MODEL", "WORKBENCH_PLANNER_MODEL", "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_BASE_URL",
  "TRENT_REASONING_EFFORT", "TRENT_MODEL_FALLBACK_ON_PIN",
];
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  clearLocalProbeCache();
});

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const SEAT_TURN: GatewayResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "seat_turn",
    schema: { type: "object", properties: { tool: { type: "string", enum: ["read_file"] }, args: { type: "object" }, final: { type: "string" } }, additionalProperties: false },
  },
};

const ANSWER = [
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '{"final":"ok"}' }, finish_reason: "stop" }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } })}\n\n`,
  "data: [DONE]\n\n",
].join("");

function chatFetch() {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    if (!url.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(ANSWER, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { fetchImpl, bodies };
}

function routeAlias(alias: ProviderAlias, model: string): void {
  process.env[PROVIDER_ALIAS_ROUTES[alias].baseUrlEnv] = DEAD;
  if (!PROVIDER_ALIAS_ROUTES[alias].local) process.env[PROVIDER_ALIAS_ROUTES[alias].apiKeyEnv] = `test-${alias}-key`;
  applyProviderAliasEnv(alias, model);
}

const ASK = [{ role: "user" as const, content: "Read notes/todo.md" }];

describe("[L1] the request body carries response_format only when asked", () => {
  it("buildCompatChatBody puts the format on the body verbatim, and leaves an unasked body unchanged", () => {
    const asked = buildCompatChatBody({ model: "m", messages: ASK, temperature: 0, maxTokens: 64, responseFormat: SEAT_TURN });
    expect(asked.response_format).toEqual(SEAT_TURN);
    const plain = buildCompatChatBody({ model: "m", messages: ASK, temperature: 0, maxTokens: 64 });
    expect(plain).not.toHaveProperty("response_format");
  });
});

describe("[L1] the gateway sends a request's responseFormat where the provider documents it", () => {
  for (const [alias, model] of [["ollama", "qwen3.5:9b"], ["lmstudio", "qwen2.5-7b-instruct"]] as const) {
    it(`${alias}: the JSON schema goes out as response_format.json_schema.schema, the path the runtime reads`, async () => {
      routeAlias(alias, model);
      const { fetchImpl, bodies } = chatFetch();
      const gateway = await createModelGateway({ fetchImpl, retry: { attempts: 1 }, retryLog: () => undefined });
      const completion = await gateway.complete({ messages: ASK, responseFormat: SEAT_TURN });
      expect(bodies).toHaveLength(1);
      expect(bodies[0]!.response_format).toEqual(SEAT_TURN);
      expect(completion.text).toBe('{"final":"ok"}');
    });
  }

  it("a request without one sends exactly the body it sent before", async () => {
    routeAlias("ollama", "qwen3.5:9b");
    const { fetchImpl, bodies } = chatFetch();
    const gateway = await createModelGateway({ fetchImpl, retry: { attempts: 1 }, retryLog: () => undefined });
    await gateway.complete({ messages: ASK });
    expect(bodies[0]).not.toHaveProperty("response_format");
  });

  it("DeepSeek and Groq get JSON mode, never a schema they may refuse", async () => {
    for (const [alias, model] of [["deepseek", "deepseek-chat"], ["groq", "llama-3.3-70b-versatile"]] as const) {
      routeAlias(alias, model);
      const { fetchImpl, bodies } = chatFetch();
      const logs: string[] = [];
      const gateway = await createModelGateway({ fetchImpl, retry: { attempts: 1 }, retryLog: (event) => logs.push(event) });
      await gateway.complete({ messages: ASK, responseFormat: SEAT_TURN });
      expect(bodies[0]!.response_format, alias).toEqual({ type: "json_object" });
      expect(logs, alias).toContain("model_gateway.response_format_downgraded");
    }
  });

  it("OpenAI itself takes the schema (structured outputs)", async () => {
    process.env.OPENAI_BASE_URL = DEAD;
    const { fetchImpl, bodies } = chatFetch();
    const gateway = await createModelGateway({ apiKeys: { openai: "test-openai-key" }, preferredProvider: "openai", allowedProviders: ["openai"], fetchImpl, retry: { attempts: 1 }, retryLog: () => undefined });
    await gateway.complete({ messages: ASK, model: "gpt-4.1-mini", responseFormat: SEAT_TURN });
    expect(bodies[0]!.response_format).toEqual(SEAT_TURN);
  });

  it("Google's OpenAI-compatible route takes the schema", async () => {
    process.env.GOOGLE_BASE_URL = DEAD;
    const { fetchImpl, bodies } = chatFetch();
    const gateway = await createModelGateway({ apiKeys: { google: "test-google-key" }, preferredProvider: "google", allowedProviders: ["google"], fetchImpl, retry: { attempts: 1 }, retryLog: () => undefined });
    process.env.GOOGLE_API_KEY = "test-google-key";
    await gateway.complete({ messages: ASK, provider: "google", model: "gemini-3.5-flash-lite", responseFormat: SEAT_TURN });
    expect(bodies[0]!.response_format).toEqual(SEAT_TURN);
  });

  it("an injected stream provider is handed the format on every attempt", async () => {
    const seen: unknown[] = [];
    const streamProvider: ProviderStreamFn = async function* (_provider, _model, input) {
      seen.push(input.responseFormat);
      yield { type: "token", content: '{"final":"ok"}' };
      yield { type: "finish", reason: "stop" };
    };
    const gateway = await createModelGateway({ streamProvider, apiKeys: { google: "test-google-key" }, preferredProvider: "google", allowedProviders: ["google"], retry: { attempts: 1 }, retryLog: () => undefined });
    await gateway.complete({ messages: ASK, responseFormat: SEAT_TURN });
    await gateway.complete({ messages: ASK });
    expect(seen).toEqual([SEAT_TURN, undefined]);
  });
});

describe("[L1] the provider table", () => {
  it("names a documented level for every route the gateway can take", () => {
    for (const label of ["ollama", "lmstudio", "openai", "google", "deepseek", "groq", "anthropic", "mistral", "openrouter"]) {
      expect(RESPONSE_FORMAT_SUPPORT[label], label).toBeDefined();
    }
  });

  it("drops the format on the app's streamers, which have no field to carry it", () => {
    for (const label of ["anthropic", "mistral", "openrouter"]) expect(responseFormatFor(label, SEAT_TURN), label).toBeUndefined();
    expect(responseFormatFor("ollama", { type: "json_object" })).toEqual({ type: "json_object" });
    expect(responseFormatFor("unknown-route", SEAT_TURN)).toBeUndefined();
  });
});
