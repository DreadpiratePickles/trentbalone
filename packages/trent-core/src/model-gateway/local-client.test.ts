/**
 * [L0-2] RED for audit G2 (item 1): every OpenAI-compatible provider streams through the WRAPPER's
 * own client (`openai-compat.ts`), not `apps/web/lib/ai-client.ts`, whose 60 s client timeout killed
 * the planner on a 27B model and whose streamer drops `prompt_tokens_details` and cannot carry
 * `reasoning_effort`.
 *
 * Offline: every response is a fixture handed to the gateway's `fetchImpl` seam, and every base URL
 * is `127.0.0.1:9` (discard, nothing listens), so a call that bypasses the seam fails on this machine
 * instead of leaving it. No key here is real.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createModelGateway } from "./index.js";
import { clearLocalProbeCache } from "./local-probe.js";
import { ALIAS_ENV, PROVIDER_ALIAS_ROUTES, applyProviderAliasEnv, type ProviderAlias } from "./providers.js";

const DEAD = "http://127.0.0.1:9/v1";

const ENV_KEYS = [
  ALIAS_ENV, "OLLAMA_BASE_URL", "LMSTUDIO_BASE_URL", "DEEPSEEK_BASE_URL", "GROQ_BASE_URL", "OLLAMA_API_KEY",
  "LMSTUDIO_API_KEY", "DEEPSEEK_API_KEY", "GROQ_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID",
  "OPENAI_PROJECT_ID", "MODEL_PREFERRED_PROVIDER", "MODEL_ALLOWED_PROVIDERS", "OPENAI_MODEL_FAST",
  "OPENAI_MODEL_DEFAULT", "OPENAI_MODEL_STRONG", "OPENAI_MODEL_CRITIC", "WORKBENCH_EXECUTOR_MODEL",
  "WORKBENCH_PLANNER_MODEL", "GEMINI_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "MISTRAL_API_KEY",
  "OPENROUTER_API_KEY", "TRENT_REASONING_EFFORT", "TRENT_MODEL_FALLBACK_ON_PIN",
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

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

function sse(chunks: readonly unknown[]): string {
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
}

const ANSWER = sse([
  { choices: [{ index: 0, delta: { role: "assistant", content: "rea" } }] },
  { choices: [{ index: 0, delta: { content: "dy" }, finish_reason: "stop" }] },
  { choices: [], usage: { prompt_tokens: 1_200, completion_tokens: 2, total_tokens: 1_202, prompt_tokens_details: { cached_tokens: 900 } } },
]);

/** A fetch that answers `/chat/completions` with `chat` and `/api/show` with `show`; records every call. */
function routedFetch(options: { chat?: string; show?: Record<string, unknown> } = {}) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    });
    if (url.endsWith("/api/show") && options.show) return new Response(JSON.stringify(options.show), { status: 200 });
    if (url.endsWith("/chat/completions")) {
      return new Response(options.chat ?? ANSWER, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetchImpl, calls, chats: () => calls.filter((call) => call.url.endsWith("/chat/completions")) };
}

function routeAlias(alias: ProviderAlias, model: string): void {
  process.env[PROVIDER_ALIAS_ROUTES[alias].baseUrlEnv] = DEAD;
  if (!PROVIDER_ALIAS_ROUTES[alias].local) process.env[PROVIDER_ALIAS_ROUTES[alias].apiKeyEnv] = `test-${alias}-key`;
  applyProviderAliasEnv(alias, model);
}

const ASK = [{ role: "user" as const, content: "Say ready" }];

describe("the wrapper's client serves every OpenAI-compatible provider", () => {
  const aliases: Array<[ProviderAlias, string]> = [
    ["ollama", "qwen3.5:9b"],
    ["lmstudio", "qwen2.5-coder-7b-instruct"],
    ["deepseek", "deepseek-chat"],
    ["groq", "llama-3.3-70b-versatile"],
  ];

  for (const [alias, model] of aliases) {
    it(`${alias}: one request through the gateway's fetch, usage asked for, cached tokens returned`, async () => {
      routeAlias(alias, model);
      const { fetchImpl, chats } = routedFetch();
      const gateway = await createModelGateway({ fetchImpl, retry: { attempts: 1 }, retryLog: () => undefined });

      const completion = await gateway.complete({ messages: ASK });

      expect(chats()).toHaveLength(1);
      const call = chats()[0]!;
      expect(call.url).toBe(`${DEAD}/chat/completions`);
      expect(call.body).toMatchObject({ model, stream: true, stream_options: { include_usage: true } });
      expect(call.headers.authorization).toBe(PROVIDER_ALIAS_ROUTES[alias].local ? "Bearer local" : `Bearer test-${alias}-key`);
      expect(completion).toMatchObject({ text: "ready", inputTokens: 1_200, outputTokens: 2, cachedInputTokens: 900, estimated: false, providerAlias: alias });
    });
  }

  it("openai itself: the same client, with the app's per-model tuning (max_completion_tokens for gpt-5)", async () => {
    process.env.OPENAI_BASE_URL = DEAD;
    process.env.OPENAI_ORG_ID = "org-test";
    const { fetchImpl, chats } = routedFetch();
    const gateway = await createModelGateway({
      apiKeys: { openai: "test-openai-key" },
      preferredProvider: "openai",
      allowedProviders: ["openai"],
      fetchImpl,
      retry: { attempts: 1 },
      retryLog: () => undefined,
    });

    await gateway.complete({ messages: ASK, model: "gpt-4.1-mini", maxTokens: 64, temperature: 0.3 });
    await gateway.complete({ messages: ASK, model: "gpt-5.2", maxTokens: 64, temperature: 0.3 });

    const [mini, five] = chats();
    expect(mini?.url).toBe(`${DEAD}/chat/completions`);
    expect(mini?.headers.authorization).toBe("Bearer test-openai-key");
    expect(mini?.headers["openai-organization"]).toBe("org-test");
    expect(mini?.body).toMatchObject({ model: "gpt-4.1-mini", max_tokens: 64, temperature: 0.3, stream_options: { include_usage: true } });
    expect(five?.body).toMatchObject({ model: "gpt-5.2", max_completion_tokens: 64 });
    expect(five?.body).not.toHaveProperty("temperature");
    expect(five?.body).not.toHaveProperty("max_tokens");
  });

  it("reads llama.cpp's `timings.cache_n` when the usage object carries no cached count", async () => {
    routeAlias("lmstudio", "local-model");
    const chat = sse([
      { choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 500, completion_tokens: 1 }, timings: { cache_n: 480, prompt_n: 20 } },
    ]);
    const { fetchImpl } = routedFetch({ chat });
    const gateway = await createModelGateway({ fetchImpl, retry: { attempts: 1 }, retryLog: () => undefined });
    expect(await gateway.complete({ messages: ASK })).toMatchObject({ inputTokens: 500, cachedInputTokens: 480 });
  });
});

describe("reasoning_effort goes only where the provider accepts it", () => {
  async function effortSent(setup: () => void, show?: Record<string, unknown>, model?: string): Promise<{ sent: unknown; logs: string[] }> {
    setup();
    const { fetchImpl, chats } = routedFetch({ ...(show ? { show } : {}) });
    const logs: string[] = [];
    const gateway = await createModelGateway({
      ...(process.env[ALIAS_ENV] ? {} : { apiKeys: { openai: "test-openai-key" }, preferredProvider: "openai" as const, allowedProviders: ["openai" as const] }),
      fetchImpl,
      reasoningEffort: "low",
      retry: { attempts: 1 },
      retryLog: (event) => logs.push(event),
    });
    await gateway.complete({ messages: ASK, ...(model ? { model } : {}) });
    return { sent: chats()[0]?.body.reasoning_effort, logs };
  }

  it("Ollama: sent when /api/show lists `thinking` (docs.ollama.com/api/openai-compatibility)", async () => {
    const { sent } = await effortSent(() => routeAlias("ollama", "qwen3.5:9b"), { capabilities: ["completion", "tools", "thinking"] });
    expect(sent).toBe("low");
  });

  it("Ollama: not sent to a model without `thinking`, and the drop is logged", async () => {
    const { sent, logs } = await effortSent(() => routeAlias("ollama", "llama3.2"), { capabilities: ["completion", "tools"] });
    expect(sent).toBeUndefined();
    expect(logs).toContain("model_gateway.reasoning_effort_not_sent");
  });

  it("LM Studio, DeepSeek and Groq: not sent (not in their chat-completions parameter lists)", async () => {
    for (const [alias, model] of [["lmstudio", "local-model"], ["deepseek", "deepseek-chat"], ["groq", "llama-3.3-70b-versatile"]] as const) {
      clearLocalProbeCache();
      const { sent } = await effortSent(() => routeAlias(alias, model));
      expect(sent, alias).toBeUndefined();
    }
  });

  it("OpenAI: sent to a reasoning model, never to a model that rejects the field", async () => {
    const setup = (): void => {
      process.env.OPENAI_BASE_URL = DEAD;
    };
    expect((await effortSent(setup, undefined, "gpt-5.2")).sent).toBe("low");
    expect((await effortSent(setup, undefined, "gpt-4.1-mini")).sent).toBeUndefined();
  });
});
