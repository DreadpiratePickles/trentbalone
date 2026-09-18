/**
 * RED for A.7 / D-7: "`ollama`, `deepseek` and `groq` are accepted everywhere and routed nowhere."
 *
 * These are WIRE tests. Each alias streams from a real local HTTP server that speaks the
 * OpenAI-compatible SSE shape, through the app's own client, so they prove the whole boundary:
 * config name -> alias route -> env -> `apps/web/lib/ai-client.ts` -> a socket. No live provider is
 * ever called and no real key exists here.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createModelGateway } from "./index.js";
import {
  ALIAS_ENV,
  KEYLESS_ALIASES,
  LOCAL_PLACEHOLDER_KEY,
  PROVIDER_ALIASES,
  PROVIDER_ALIAS_ROUTES,
  activeProviderAlias,
  aliasBaseUrl,
  applyProviderAliasEnv,
  isProviderAlias,
  resolveProviderAlias,
} from "./providers.js";
import type { ProviderAlias } from "./providers.js";
import type { GatewayStreamEvent } from "./types.js";

interface RecordedRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  body: { model?: string; stream?: boolean; messages?: Array<{ role: string; content: string }> };
}

interface FakeServer {
  baseUrl: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}

/** An OpenAI-compatible `/chat/completions` SSE endpoint: two token chunks, usage, then DONE. */
async function startFakeOpenAiServer(): Promise<FakeServer> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      let body: RecordedRequest["body"] = {};
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        body = {};
      }
      requests.push({ method: req.method ?? "", url: req.url ?? "", authorization: req.headers.authorization, body });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const frame = (payload: unknown): void => {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      };
      frame({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "PONG" } }] });
      frame({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "-7423" } }] });
      frame({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      frame({ id: "1", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } });
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * Cleared before every test. The core keys matter as much as the alias ones: a leaked
 * `GEMINI_API_KEY` would put a live provider in the fallback chain, and an alias failure would then
 * reach for the network. No test in this file may ever leave this machine.
 */
const ENV_KEYS = [
  ALIAS_ENV,
  "OLLAMA_BASE_URL",
  "LMSTUDIO_BASE_URL",
  "DEEPSEEK_BASE_URL",
  "GROQ_BASE_URL",
  "OLLAMA_API_KEY",
  "LMSTUDIO_API_KEY",
  "DEEPSEEK_API_KEY",
  "GROQ_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_MODEL_FAST",
  "OPENAI_MODEL_DEFAULT",
  "OPENAI_MODEL_STRONG",
  "OPENAI_MODEL_CRITIC",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "MISTRAL_API_KEY",
  "OPENROUTER_API_KEY",
  "MODEL_PREFERRED_PROVIDER",
  "MODEL_ALLOWED_PROVIDERS",
  "WORKBENCH_EXECUTOR_MODEL",
  "WORKBENCH_PLANNER_MODEL",
];

const saved = new Map<string, string | undefined>();

function clearEnv(): void {
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
}

function restoreEnv(): void {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe("the alias registry", () => {
  beforeEach(clearEnv);
  afterEach(restoreEnv);

  it("declares exactly the four names the config accepts but the app's router does not know", () => {
    expect([...PROVIDER_ALIASES].sort()).toEqual(["deepseek", "groq", "lmstudio", "ollama"]);
    for (const alias of PROVIDER_ALIASES) expect(isProviderAlias(alias)).toBe(true);
    expect(isProviderAlias("anthropic")).toBe(false);
    expect(resolveProviderAlias("OLLAMA")?.alias).toBe("ollama");
    expect(resolveProviderAlias("anthropic")).toBeUndefined();
  });

  it("resolves every alias to a provider identity the app already understands", () => {
    for (const alias of PROVIDER_ALIASES) {
      expect(PROVIDER_ALIAS_ROUTES[alias].provider, alias).toBe("openai");
    }
  });

  it("ships the documented default base URLs and lets an operator override each by env", () => {
    expect(aliasBaseUrl("ollama")).toBe("http://127.0.0.1:11434/v1");
    expect(aliasBaseUrl("lmstudio")).toBe("http://127.0.0.1:1234/v1");
    expect(aliasBaseUrl("deepseek")).toBe("https://api.deepseek.com/v1");
    expect(aliasBaseUrl("groq")).toBe("https://api.groq.com/openai/v1");

    process.env.OLLAMA_BASE_URL = "http://10.0.0.4:11434/v1/";
    expect(aliasBaseUrl("ollama")).toBe("http://10.0.0.4:11434/v1");
  });

  it("marks the local runtimes keyless and the hosted ones key-bearing", () => {
    expect([...KEYLESS_ALIASES].sort()).toEqual(["lmstudio", "ollama"]);
    expect(PROVIDER_ALIAS_ROUTES.deepseek.apiKeyEnv).toBe("DEEPSEEK_API_KEY");
    expect(PROVIDER_ALIAS_ROUTES.groq.apiKeyEnv).toBe("GROQ_API_KEY");
  });
});

describe("applyProviderAliasEnv — the boundary", () => {
  beforeEach(clearEnv);
  afterEach(restoreEnv);

  it("writes the OpenAI-compatible env the app's client reads, and names only variables", () => {
    const report = applyProviderAliasEnv("ollama", "llama3.2");
    expect(report.unroutable).toBeUndefined();
    expect(process.env.MODEL_PREFERRED_PROVIDER).toBe("openai");
    expect(process.env.OPENAI_BASE_URL).toBe("http://127.0.0.1:11434/v1");
    expect(process.env.OPENAI_MODEL_DEFAULT).toBe("llama3.2");
    expect(process.env[ALIAS_ENV]).toBe("ollama");
    expect(activeProviderAlias()).toBe("ollama");
    expect(report.written.join(" ")).not.toContain("llama3.2");
  });

  it("never sends the operator's real OpenAI key to a local endpoint", () => {
    process.env.OPENAI_API_KEY = "sk-a-real-openai-key-that-must-not-travel";
    applyProviderAliasEnv("ollama", "llama3.2");
    expect(process.env.OPENAI_API_KEY).toBe(LOCAL_PLACEHOLDER_KEY);
  });

  it("uses the local runtime's own token when the operator set one", () => {
    process.env.OLLAMA_API_KEY = "ollama-gateway-token";
    applyProviderAliasEnv("ollama", "llama3.2");
    expect(process.env.OPENAI_API_KEY).toBe("ollama-gateway-token");
  });

  it("routes a hosted alias with its own key", () => {
    process.env.GROQ_API_KEY = "gsk-test-key-0123456789";
    const report = applyProviderAliasEnv("groq", "llama-3.3-70b-versatile");
    expect(report.unroutable).toBeUndefined();
    expect(process.env.OPENAI_BASE_URL).toBe("https://api.groq.com/openai/v1");
    expect(process.env.OPENAI_API_KEY).toBe("gsk-test-key-0123456789");
  });

  it("refuses to route a hosted alias with no key instead of leaving the run to drift elsewhere", () => {
    const report = applyProviderAliasEnv("deepseek", "deepseek-chat");
    expect(report.unroutable).toContain("DEEPSEEK_API_KEY");
    expect(process.env.OPENAI_BASE_URL).toBeUndefined();
    expect(process.env.MODEL_PREFERRED_PROVIDER).toBeUndefined();
  });

  it("keeps an endpoint the operator pinned explicitly", () => {
    process.env.OPENAI_BASE_URL = "http://127.0.0.1:9999/v1";
    const report = applyProviderAliasEnv("ollama", "llama3.2");
    expect(process.env.OPENAI_BASE_URL).toBe("http://127.0.0.1:9999/v1");
    expect(report.kept).toContain("OPENAI_BASE_URL");
  });
});

describe("every declared provider routes somewhere real", () => {
  let server: FakeServer;

  beforeEach(async () => {
    clearEnv();
    server = await startFakeOpenAiServer();
  });

  afterEach(async () => {
    await server.close();
    restoreEnv();
  });

  async function streamThroughAlias(alias: ProviderAlias, model: string): Promise<GatewayStreamEvent[]> {
    // A run starts in a fresh process, where the alias owns these. Within one test file they
    // persist, and `applyProviderAliasEnv` deliberately keeps a value an operator already set.
    for (const name of ["OPENAI_BASE_URL", "OPENAI_MODEL_FAST", "OPENAI_MODEL_DEFAULT", "OPENAI_MODEL_STRONG", "OPENAI_MODEL_CRITIC"]) {
      delete process.env[name];
    }
    process.env[PROVIDER_ALIAS_ROUTES[alias].baseUrlEnv] = server.baseUrl;
    applyProviderAliasEnv(alias, model);
    const gateway = await createModelGateway();
    const events: GatewayStreamEvent[] = [];
    for await (const event of gateway.stream({ messages: [{ role: "user", content: "say PONG-7423" }] })) {
      events.push(event);
    }
    return events;
  }

  const cases: Array<{ alias: ProviderAlias; model: string; key?: string }> = [
    { alias: "ollama", model: "llama3.2" },
    { alias: "lmstudio", model: "qwen2.5-coder-7b-instruct" },
    { alias: "deepseek", model: "deepseek-chat", key: "sk-deepseek-test-key-0123456789" },
    { alias: "groq", model: "llama-3.3-70b-versatile", key: "gsk-test-key-0123456789" },
  ];

  for (const { alias, model, key } of cases) {
    it(`${alias} streams real tokens from its OpenAI-compatible endpoint`, async () => {
      if (key) process.env[PROVIDER_ALIAS_ROUTES[alias].apiKeyEnv] = key;
      const events = await streamThroughAlias(alias, model);

      const text = events.filter((e) => e.type === "token").map((e) => (e.type === "token" ? e.content : "")).join("");
      expect(text).toBe("PONG-7423");
      expect(text).not.toMatch(/^Trent proxy response/);

      const usage = events.find((e) => e.type === "usage");
      expect(usage).toMatchObject({
        type: "usage",
        provider: "openai",
        providerAlias: alias,
        model,
        inputTokens: 11,
        outputTokens: 7,
        estimated: false,
      });
      expect(events.at(-1)).toMatchObject({ type: "finish", reason: "stop" });

      expect(server.requests).toHaveLength(1);
      const request = server.requests[0]!;
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/v1/chat/completions");
      expect(request.body.model).toBe(model);
      expect(request.body.stream).toBe(true);
      expect(request.body.messages?.at(-1)?.content).toContain("PONG-7423");
      expect(request.authorization).toBe(`Bearer ${key ?? LOCAL_PLACEHOLDER_KEY}`);
    });
  }

  it("bills a local alias at zero and a hosted one from the price table", async () => {
    const local = await streamThroughAlias("ollama", "llama3.2");
    const localUsage = local.find((e) => e.type === "usage");
    if (localUsage?.type !== "usage") throw new Error("no usage event");
    expect(localUsage.costCents).toBe(0);
    expect(localUsage.unpriced).toBe(false);

    process.env.GROQ_API_KEY = "gsk-test-key-0123456789";
    const hosted = await streamThroughAlias("groq", "llama-3.3-70b-versatile");
    const hostedUsage = hosted.find((e) => e.type === "usage");
    if (hostedUsage?.type !== "usage") throw new Error("no usage event");
    expect(hostedUsage.unpriced).toBe(false);
    expect(hostedUsage.providerAlias).toBe("groq");
  });

  it("resolves an alias handed straight to the factory, for the surfaces that build their own gateway", async () => {
    // `trent heartbeat` and `trent improve` call createModelGateway({ preferredProvider: config.provider })
    // without going through the orchestrator's env bridge first.
    process.env.OLLAMA_BASE_URL = server.baseUrl;
    const gateway = await createModelGateway({
      preferredProvider: "ollama" as unknown as "openai",
      models: { executor: "llama3.2" },
    });
    const events: GatewayStreamEvent[] = [];
    for await (const event of gateway.stream({ messages: [{ role: "user", content: "say PONG-7423" }] })) {
      events.push(event);
    }
    expect(events.filter((e) => e.type === "token").map((e) => (e.type === "token" ? e.content : "")).join("")).toBe("PONG-7423");
    expect(events.find((e) => e.type === "usage")).toMatchObject({ providerAlias: "ollama", model: "llama3.2" });
    expect(server.requests[0]?.url).toBe("/v1/chat/completions");
  });

  it("refuses to build a gateway for an alias it cannot route, with the typed configuration error", async () => {
    await expect(
      createModelGateway({ preferredProvider: "deepseek" as unknown as "openai", models: { executor: "deepseek-chat" } }),
    ).rejects.toMatchObject({ code: 3, operation: "model.route" });
  });

  it("surfaces a non-2xx from the endpoint as an error, never as a silent degrade", async () => {
    const failing = http.createServer((_req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: 'model "nope" not found' } }));
    });
    await new Promise<void>((resolve) => failing.listen(0, "127.0.0.1", resolve));
    const { port } = failing.address() as AddressInfo;
    process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${port}/v1`;
    applyProviderAliasEnv("ollama", "nope");
    try {
      const gateway = await createModelGateway();
      await expect(
        (async () => {
          for await (const _event of gateway.stream({ messages: [{ role: "user", content: "hi" }] })) {
            // drain
          }
        })(),
      ).rejects.toThrow(/404/);
    } finally {
      await new Promise<void>((resolve) => failing.close(() => resolve()));
    }
  });
});
