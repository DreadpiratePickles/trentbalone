/**
 * [L0-2] RED for item 4 (research §8.1 G6, F10): a local runtime serves few requests at once —
 * Ollama "OLLAMA_NUM_PARALLEL ... default 1" (https://docs.ollama.com/faq), LM Studio "Max
 * Concurrent Predictions is set to 4" (https://lmstudio.ai/docs/app/advanced/parallel-requests) — so
 * the gateway queues the rest itself, where the wait does not eat a call's time-to-first-token budget.
 *
 * A real local HTTP server records how many chat requests it is holding at once. Nothing leaves
 * 127.0.0.1 and no key here is real.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createModelGateway } from "./index.js";
import { clearLocalProbeCache } from "./local-probe.js";
import {
  DEFAULT_MAX_IN_FLIGHT,
  LOCAL_MODEL_DEFAULTS,
  LOCAL_MODEL_ENV,
  applyLocalModelEnv,
  localModelPolicy,
} from "./local-runtime.js";
import { ALIAS_ENV, applyProviderAliasEnv, type ProviderAlias } from "./providers.js";

const ENV_KEYS = [
  ALIAS_ENV, "OLLAMA_BASE_URL", "LMSTUDIO_BASE_URL", "OPENAI_API_KEY", "OPENAI_BASE_URL", "MODEL_PREFERRED_PROVIDER",
  "OPENAI_MODEL_FAST", "OPENAI_MODEL_DEFAULT", "OPENAI_MODEL_STRONG", "OPENAI_MODEL_CRITIC", "WORKBENCH_EXECUTOR_MODEL",
  "WORKBENCH_PLANNER_MODEL", "GEMINI_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "MISTRAL_API_KEY", "OPENROUTER_API_KEY",
  ...Object.values(LOCAL_MODEL_ENV),
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

describe("models.local: the env bridge and the defaults", () => {
  it("writes only what is configured and names what it wrote", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(applyLocalModelEnv({ ttft_seconds: 600, max_in_flight: 2 }, env)).toEqual([LOCAL_MODEL_ENV.ttftSeconds, LOCAL_MODEL_ENV.maxInFlight]);
    expect(env).toEqual({ [LOCAL_MODEL_ENV.ttftSeconds]: "600", [LOCAL_MODEL_ENV.maxInFlight]: "2" });
    expect(applyLocalModelEnv(undefined, env)).toEqual([]);
  });

  it("defaults: 300 s to the first token, 120 s between tokens, a 32768-token window, 1 in flight on Ollama and 4 on LM Studio", () => {
    expect(LOCAL_MODEL_DEFAULTS).toEqual({ ttftSeconds: 300, idleSeconds: 120, contextTokens: 32_768 });
    expect(DEFAULT_MAX_IN_FLIGHT).toEqual({ ollama: 1, lmstudio: 4 });
    expect(localModelPolicy("ollama", {})).toEqual({ ttftMs: 300_000, idleMs: 120_000, contextTokens: 32_768, maxInFlight: 1 });
    expect(localModelPolicy("lmstudio", {}).maxInFlight).toBe(4);
  });

  it("reads the bridge, and ignores a value that is not a positive whole number", () => {
    const env = { [LOCAL_MODEL_ENV.ttftSeconds]: "900", [LOCAL_MODEL_ENV.idleSeconds]: "abc", [LOCAL_MODEL_ENV.contextTokens]: "65536", [LOCAL_MODEL_ENV.maxInFlight]: "0" };
    expect(localModelPolicy("ollama", env)).toEqual({ ttftMs: 900_000, idleMs: 120_000, contextTokens: 65_536, maxInFlight: 1 });
  });
});

interface OverlapServer {
  readonly baseUrl: string;
  readonly maxInFlight: () => number;
  readonly served: () => number;
  readonly close: () => Promise<void>;
}

/** Holds every chat request `holdMs` before answering, and records the most it held at once. */
async function overlapServer(holdMs: number): Promise<OverlapServer> {
  let active = 0;
  let max = 0;
  let served = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (!req.url?.endsWith("/chat/completions")) {
        res.writeHead(404).end();
        return;
      }
      active += 1;
      max = Math.max(max, active);
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } })}\n\n`);
        res.end("data: [DONE]\n\n");
        active -= 1;
        served += 1;
      }, holdMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    maxInFlight: () => max,
    served: () => served,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function concurrentCalls(alias: ProviderAlias, server: OverlapServer, calls: number, gateways = 1): Promise<string[]> {
  process.env[alias === "ollama" ? "OLLAMA_BASE_URL" : "LMSTUDIO_BASE_URL"] = server.baseUrl;
  applyProviderAliasEnv(alias, "qwen3.5:9b");
  const built = await Promise.all(Array.from({ length: gateways }, () => createModelGateway({ retryLog: () => undefined })));
  const results = await Promise.all(
    Array.from({ length: calls }, (_, i) => built[i % gateways]!.complete({ messages: [{ role: "user", content: `call ${i}` }] })),
  );
  return results.map((r) => r.text);
}

describe("the gateway caps concurrent calls to a local runtime", () => {
  let server: OverlapServer;
  afterEach(async () => server.close());

  it("Ollama: three concurrent calls reach the server one at a time, and all three complete", async () => {
    server = await overlapServer(120);
    expect(await concurrentCalls("ollama", server, 3)).toEqual(["ok", "ok", "ok"]);
    expect(server.maxInFlight()).toBe(1);
    expect(server.served()).toBe(3);
  });

  it("the cap is per endpoint and per process: two gateways share it", async () => {
    server = await overlapServer(120);
    await concurrentCalls("ollama", server, 4, 2);
    expect(server.maxInFlight()).toBe(1);
  });

  it("models.local.max_in_flight raises it", async () => {
    process.env[LOCAL_MODEL_ENV.maxInFlight] = "2";
    server = await overlapServer(120);
    await concurrentCalls("ollama", server, 4);
    expect(server.maxInFlight()).toBe(2);
  });

  it("LM Studio's default of 4 lets three through together", async () => {
    server = await overlapServer(120);
    await concurrentCalls("lmstudio", server, 3);
    expect(server.maxInFlight()).toBe(3);
  });

  it("a consumer that stops reading after its first token frees the slot for the next call", async () => {
    server = await overlapServer(50);
    process.env.OLLAMA_BASE_URL = server.baseUrl;
    applyProviderAliasEnv("ollama", "qwen3.5:9b");
    const gateway = await createModelGateway({ retryLog: () => undefined });
    for await (const event of gateway.stream({ messages: [{ role: "user", content: "first" }] })) {
      if (event.type === "token") break; // no abort, no failure: the reader just stops
    }
    const next = await Promise.race([
      gateway.complete({ messages: [{ role: "user", content: "second" }] }).then((r) => r.text),
      new Promise<string>((resolve) => setTimeout(() => resolve("still queued"), 2_000)),
    ]);
    expect(next).toBe("ok");
  });

  it("a call cancelled while it waits for a slot leaves the queue and never reaches the server", async () => {
    server = await overlapServer(200);
    process.env.OLLAMA_BASE_URL = server.baseUrl;
    applyProviderAliasEnv("ollama", "qwen3.5:9b");
    const gateway = await createModelGateway({ retryLog: () => undefined });
    const first = gateway.complete({ messages: [{ role: "user", content: "first" }] });
    const controller = new AbortController();
    const second = gateway.complete({ messages: [{ role: "user", content: "second" }], signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort(new Error("user pressed ctrl+c"));
    expect((await second).finishReason).toBe("aborted");
    expect((await first).text).toBe("ok");
    expect(server.served()).toBe(1);
  });
});
