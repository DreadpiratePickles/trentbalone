/**
 * [L0-2] RED for audit G17: the EFFECTIVE context window of a local model, read from the server.
 *
 * The trained maximum is not the window. On this machine `/api/show` says `qwen35.context_length:
 * 262144` for `qwen3.5:9b` while `/api/ps` says the loaded model runs at `context_length: 32768`
 * (Ollama 0.32.9, read 2026-09-25), and Ollama's default is 4k under 24 GiB of VRAM
 * (https://docs.ollama.com/context-length). So the loaded window is read first, a configured
 * `num_ctx` second, and `models.local.context_tokens` is the fallback, never the model's maximum.
 * Offline: every server is a fixture behind an injected fetch.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { clearLocalProbeCache, ollamaCapabilities, readContextWindow } from "./local-probe.js";

const BASE = "http://127.0.0.1:9/v1";

type Routes = Record<string, unknown>;

function jsonFetch(routes: Routes) {
  const seen: string[] = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const path = new URL(url).pathname;
    seen.push(`${init?.method ?? "GET"} ${path}`);
    const body = routes[path];
    return body === undefined ? new Response("not found", { status: 404 }) : new Response(JSON.stringify(body), { status: 200 });
  };
  return { fetchImpl, seen };
}

beforeEach(() => clearLocalProbeCache());

describe("readContextWindow — Ollama", () => {
  it("a loaded model: /api/ps context_length, not the trained maximum", async () => {
    const { fetchImpl } = jsonFetch({
      "/api/ps": { models: [{ name: "qwen3.5:9b", model: "qwen3.5:9b", context_length: 32_768 }] },
      "/api/show": { parameters: "temperature 1", model_info: { "qwen35.context_length": 262_144 }, capabilities: ["completion", "thinking"] },
    });
    expect(await readContextWindow({ alias: "ollama", baseUrl: BASE, model: "qwen3.5:9b", fallbackTokens: 32_768, fetchImpl })).toMatchObject({
      tokens: 32_768,
      source: "ollama /api/ps",
    });
  });

  it("a model named without its tag matches the loaded `:latest`", async () => {
    const { fetchImpl } = jsonFetch({ "/api/ps": { models: [{ name: "llama3.2:latest", model: "llama3.2:latest", context_length: 4_096 }] } });
    expect((await readContextWindow({ alias: "ollama", baseUrl: BASE, model: "llama3.2", fallbackTokens: 32_768, fetchImpl })).tokens).toBe(4_096);
  });

  it("not loaded: a Modelfile num_ctx wins; with none, the configured tokens capped by the model's maximum", async () => {
    const withCtx = jsonFetch({ "/api/ps": { models: [] }, "/api/show": { parameters: "num_ctx                        8192\ntemperature 1", model_info: { "llama.context_length": 131_072 } } });
    expect(await readContextWindow({ alias: "ollama", baseUrl: BASE, model: "m", fallbackTokens: 32_768, fetchImpl: withCtx.fetchImpl })).toMatchObject({
      tokens: 8_192,
      source: "ollama /api/show num_ctx",
    });
    clearLocalProbeCache();
    const small = jsonFetch({ "/api/ps": { models: [] }, "/api/show": { parameters: "", model_info: { "gemma.context_length": 8_192 } } });
    expect(await readContextWindow({ alias: "ollama", baseUrl: BASE, model: "m", fallbackTokens: 32_768, fetchImpl: small.fetchImpl })).toMatchObject({
      tokens: 8_192,
      source: "models.local.context_tokens",
    });
  });

  it("an unreachable server falls back to models.local.context_tokens", async () => {
    const fetchImpl = async (): Promise<Response> => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    };
    expect(await readContextWindow({ alias: "ollama", baseUrl: BASE, model: "m", fallbackTokens: 16_384, fetchImpl })).toEqual({
      tokens: 16_384,
      source: "models.local.context_tokens",
    });
  });

  it("caches a window the server reported, so a run asks once per model", async () => {
    const { fetchImpl, seen } = jsonFetch({ "/api/ps": { models: [{ name: "m:latest", model: "m:latest", context_length: 65_536 }] } });
    await readContextWindow({ alias: "ollama", baseUrl: BASE, model: "m", fallbackTokens: 32_768, fetchImpl });
    await readContextWindow({ alias: "ollama", baseUrl: BASE, model: "m", fallbackTokens: 32_768, fetchImpl });
    expect(seen).toEqual(["GET /api/ps"]);
  });
});

describe("readContextWindow — llama.cpp and LM Studio", () => {
  it("llama.cpp behind an alias: /props default_generation_settings.n_ctx (the per-slot window)", async () => {
    const { fetchImpl } = jsonFetch({ "/props": { default_generation_settings: { n_ctx: 16_384 }, total_slots: 2 } });
    expect(await readContextWindow({ alias: "ollama", baseUrl: BASE, model: "any", fallbackTokens: 32_768, fetchImpl })).toMatchObject({
      tokens: 16_384,
      source: "llama.cpp /props",
    });
  });

  it("LM Studio: the loaded instance's context_length from /api/v1/models", async () => {
    const { fetchImpl } = jsonFetch({
      "/api/v1/models": { models: [{ key: "google/gemma-4-26b-a4b", loaded_instances: [{ id: "google/gemma-4-26b-a4b", config: { context_length: 4_096, parallel: 4 } }], max_context_length: 262_144 }] },
    });
    expect(await readContextWindow({ alias: "lmstudio", baseUrl: "http://127.0.0.1:9/v1", model: "google/gemma-4-26b-a4b", fallbackTokens: 32_768, fetchImpl })).toMatchObject({
      tokens: 4_096,
      source: "lmstudio /api/v1/models",
    });
  });
});

describe("ollamaCapabilities", () => {
  it("reads /api/show capabilities, and says nothing when the server cannot be asked", async () => {
    const { fetchImpl } = jsonFetch({ "/api/show": { capabilities: ["completion", "tools", "thinking"] } });
    expect(await ollamaCapabilities({ baseUrl: BASE, model: "qwen3.5:9b", fetchImpl })).toEqual(["completion", "tools", "thinking"]);
    clearLocalProbeCache();
    expect(await ollamaCapabilities({ baseUrl: BASE, model: "qwen3.5:9b", fetchImpl: jsonFetch({}).fetchImpl })).toBeUndefined();
  });
});
