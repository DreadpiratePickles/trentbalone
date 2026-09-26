/**
 * [L1] Thinking off for local seats, and the `models.local` keys small models need.
 *
 * L0-3 and L0-2 measured it live (docs/sessions/2026-09-26-harness-landscape.md): qwen3.5:9b thinks by
 * default, 1,267 thinking tokens at 3 tok/s on one seat step until the app's job timeout ended the
 * run, and 2 tokens with thinking off. So a seat (and the wrapper's consolidator) on a local runtime
 * asks for `reasoning_effort: none` unless `models.local.reasoning_effort` says otherwise; the planner
 * and the critic keep `models.reasoning_effort`. Ollama maps `none` to `think: false`
 * (`openai/openai.go` `ThinkingFromReasoningEffort`); where the provider does not take the field
 * (LM Studio) L0-2's rule drops it as before.
 *
 * Offline: fixtures through the gateway's `fetchImpl`, base URLs on 127.0.0.1:9, no real key.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MODEL_CALL_ENV } from "./call-policy.js";
import { createModelGateway } from "./index.js";
import { clearLocalProbeCache } from "./local-probe.js";
import {
  LOCAL_MODEL_ENV,
  LOCAL_SMALL_MODEL_DEFAULTS,
  applyLocalModelEnv,
  constrainedOutputApplies,
  localReasoningEffort,
} from "./local-runtime.js";
import { ALIAS_ENV, PROVIDER_ALIAS_ROUTES, applyProviderAliasEnv, type ProviderAlias } from "./providers.js";

const DEAD = "http://127.0.0.1:9/v1";

const ENV_KEYS = [
  ALIAS_ENV, "OLLAMA_BASE_URL", "LMSTUDIO_BASE_URL", "OPENAI_API_KEY", "OPENAI_BASE_URL", "MODEL_PREFERRED_PROVIDER",
  "MODEL_ALLOWED_PROVIDERS", "OPENAI_MODEL_FAST", "OPENAI_MODEL_DEFAULT", "OPENAI_MODEL_STRONG", "OPENAI_MODEL_CRITIC",
  "WORKBENCH_EXECUTOR_MODEL", "WORKBENCH_PLANNER_MODEL", "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_BASE_URL",
  MODEL_CALL_ENV.reasoningEffort, MODEL_CALL_ENV.fallbackOnPin, ...Object.values(LOCAL_MODEL_ENV),
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

const ANSWER = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;

function chatFetch() {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.endsWith("/api/show")) return new Response(JSON.stringify({ capabilities: ["completion", "tools", "thinking"] }), { status: 200 });
    if (!url.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(ANSWER, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { fetchImpl, bodies };
}

function routeAlias(alias: ProviderAlias, model: string): void {
  process.env[PROVIDER_ALIAS_ROUTES[alias].baseUrlEnv] = DEAD;
  applyProviderAliasEnv(alias, model);
}

const ASK = [{ role: "user" as const, content: "Say ready" }];

describe("[L1] thinking is off for local seats and the consolidator by default", () => {
  it("an executor call on Ollama sends reasoning_effort none; a planner call keeps models.reasoning_effort", async () => {
    routeAlias("ollama", "qwen3.5:9b");
    process.env[MODEL_CALL_ENV.reasoningEffort] = "high";
    const { fetchImpl, bodies } = chatFetch();
    const gateway = await createModelGateway({ fetchImpl, retry: { attempts: 1 }, retryLog: () => undefined });
    await gateway.complete({ role: "executor", messages: ASK });
    await gateway.complete({ role: "planner", messages: ASK });
    expect(bodies.map((body) => body.reasoning_effort)).toEqual(["none", "high"]);
  });

  it("models.local.reasoning_effort replaces the default for local executor calls", async () => {
    routeAlias("ollama", "qwen3.5:9b");
    applyLocalModelEnv({ reasoning_effort: "low" });
    const { fetchImpl, bodies } = chatFetch();
    const gateway = await createModelGateway({ fetchImpl, retry: { attempts: 1 }, retryLog: () => undefined });
    await gateway.complete({ messages: ASK });
    expect(bodies[0]!.reasoning_effort).toBe("low");
  });

  it("the request's own effort and the gateway's explicit one still win", async () => {
    routeAlias("ollama", "qwen3.5:9b");
    const { fetchImpl, bodies } = chatFetch();
    const gateway = await createModelGateway({ fetchImpl, retry: { attempts: 1 }, retryLog: () => undefined });
    await gateway.complete({ messages: ASK, reasoningEffort: "medium" });
    const explicit = await createModelGateway({ fetchImpl, reasoningEffort: "high", retry: { attempts: 1 }, retryLog: () => undefined });
    await explicit.complete({ messages: ASK });
    expect(bodies.map((body) => body.reasoning_effort)).toEqual(["medium", "high"]);
  });

  it("a request routed explicitly to a hosted provider under a local alias does not get the local default", async () => {
    routeAlias("ollama", "qwen3.5:9b");
    process.env.GOOGLE_BASE_URL = DEAD;
    const { fetchImpl, bodies } = chatFetch();
    const gateway = await createModelGateway({ apiKeys: { google: "test-google-key" }, fetchImpl, retry: { attempts: 1 }, retryLog: () => undefined });
    await gateway.complete({ messages: ASK, provider: "google", model: "gemini-3.6-pro" });
    expect(bodies[0]).not.toHaveProperty("reasoning_effort"); // Gemini 3 refuses `none`
    delete process.env.GOOGLE_BASE_URL;
  });

  it("LM Studio is not sent the field (its chat-completions list has none), as before", async () => {
    routeAlias("lmstudio", "qwen2.5-7b-instruct");
    const { fetchImpl, bodies } = chatFetch();
    const gateway = await createModelGateway({ fetchImpl, retry: { attempts: 1 }, retryLog: () => undefined });
    await gateway.complete({ messages: ASK });
    expect(bodies[0]).not.toHaveProperty("reasoning_effort");
  });

  it("a hosted provider's executor call is untouched by the local default", async () => {
    process.env.OPENAI_BASE_URL = DEAD;
    process.env[MODEL_CALL_ENV.reasoningEffort] = "high";
    const { fetchImpl, bodies } = chatFetch();
    const gateway = await createModelGateway({ apiKeys: { openai: "test-openai-key" }, preferredProvider: "openai", allowedProviders: ["openai"], fetchImpl, retry: { attempts: 1 }, retryLog: () => undefined });
    await gateway.complete({ messages: ASK, model: "gpt-5.2" });
    expect(bodies[0]!.reasoning_effort).toBe("high");
  });
});

describe("[L1] the models.local keys for small models", () => {
  it("defaults: thinking none, constrained output on for local providers, a 1800 s job timeout", () => {
    expect(LOCAL_SMALL_MODEL_DEFAULTS).toEqual({ reasoningEffort: "none", constrainedOutput: true, jobTimeoutSeconds: 1800 });
    expect(localReasoningEffort({})).toBe("none");
  });

  it("the bridge writes only what is configured, and an unknown effort is not written", () => {
    const env: NodeJS.ProcessEnv = {};
    const written = applyLocalModelEnv({ reasoning_effort: "low", constrained_output: "all" }, env);
    expect(written).toEqual([LOCAL_MODEL_ENV.reasoningEffort, LOCAL_MODEL_ENV.constrainedOutput]);
    expect(localReasoningEffort(env)).toBe("low");
    expect(applyLocalModelEnv({ reasoning_effort: "turbo" } as never, {})).toEqual([]);
  });

  it("constrained output: on for a local alias by default, off for a hosted one unless it is `all`", () => {
    expect(constrainedOutputApplies({ [ALIAS_ENV]: "ollama" })).toBe(true);
    expect(constrainedOutputApplies({ [ALIAS_ENV]: "lmstudio" })).toBe(true);
    expect(constrainedOutputApplies({ [ALIAS_ENV]: "ollama", [LOCAL_MODEL_ENV.constrainedOutput]: "false" })).toBe(false);
    expect(constrainedOutputApplies({})).toBe(false);
    expect(constrainedOutputApplies({ [ALIAS_ENV]: "groq" })).toBe(false);
    expect(constrainedOutputApplies({ [LOCAL_MODEL_ENV.constrainedOutput]: "all" })).toBe(true);
  });

  it("[item 6] a gateway built with `local` writes the same bridge the headless runtime writes", async () => {
    routeAlias("ollama", "qwen3.5:9b");
    await createModelGateway({ local: { ttft_seconds: 900, max_in_flight: 2, constrained_output: false }, retry: { attempts: 1 }, retryLog: () => undefined });
    expect(process.env[LOCAL_MODEL_ENV.ttftSeconds]).toBe("900");
    expect(process.env[LOCAL_MODEL_ENV.maxInFlight]).toBe("2");
    expect(process.env[LOCAL_MODEL_ENV.constrainedOutput]).toBe("false");
  });
});
