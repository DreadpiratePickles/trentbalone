/**
 * [L0-5] G10: the wrapped app's own embedding calls under a local model.
 *
 * `apps/web/lib/wiki-embeddings.ts` embeds every step's objective (`source-grounding.ts:41`) and
 * `semantic-router.ts` embeds for routing. Both read `EMBEDDING_MODEL` once, at module load (default
 * `text-embedding-3-small`), and send it to `OPENAI_BASE_URL` whenever `OPENAI_API_KEY` is set. Under a
 * local alias that URL is the local runtime, so every step was a 404 there. The app is read-only, so the
 * wrapper writes `EMBEDDING_MODEL` from `memory.embedder` in `applyModelEnv`, the one place the app's env is
 * prepared, before either module loads.
 *
 * `OPENAI_API_KEY` is the only variable that switches those calls OFF, and the app's OpenAI chat client
 * needs the same variable, so `memory.embedder.provider: none` cannot silence them by env. What IS held
 * here: under `none` the wrapper's own embedder makes no request, and the app's call stays on the loopback
 * runtime the alias named.
 *
 * The fake runtime is an HTTP server on 127.0.0.1; nothing here leaves the machine.
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyModelEnv, type ModelEnvConfig } from "../orchestrator/model-env.js";
import { applyAppEmbeddingEnv } from "./embedder-local.js";
import { createEmbedder } from "./embedder.js";

interface FakeRuntime {
  readonly url: string;
  readonly embeddings: Array<{ path: string; model: string }>;
  close(): Promise<void>;
}

/** An OpenAI-compatible runtime that knows exactly one embedding model and 404s any other, as Ollama does. */
async function fakeRuntime(knownModel: string): Promise<FakeRuntime> {
  const embeddings: Array<{ path: string; model: string }> = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += String(chunk)));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as { model?: string; input?: string[] | string };
      embeddings.push({ path: req.url ?? "", model: body.model ?? "" });
      if (body.model !== knownModel) {
        res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: `model "${String(body.model)}" not found, try pulling it first` }));
        return;
      }
      const inputs = Array.isArray(body.input) ? body.input : [body.input ?? ""];
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        object: "list",
        model: knownModel,
        data: inputs.map((_, index) => ({ object: "embedding", index, embedding: Array.from({ length: 8 }, (_v, i) => (i === index % 8 ? 1 : 0.1)) })),
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${String(port)}`, embeddings, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** Cleared before each case; the whole environment is restored after it, since `applyModelEnv` writes several. */
const MODEL_ENV_NAMES = [
  "TRENT_MODEL_ALIAS", "MODEL_PREFERRED_PROVIDER", "OPENAI_BASE_URL", "OPENAI_API_KEY", "OLLAMA_BASE_URL", "OLLAMA_API_KEY",
  "OPENAI_MODEL_FAST", "OPENAI_MODEL_DEFAULT", "OPENAI_MODEL_STRONG", "OPENAI_MODEL_CRITIC", "EMBEDDING_MODEL", "WIKI_EMBED_STORE",
];

describe("[L0-5] G10: the app's embeddings follow memory.embedder", () => {
  let saved: Record<string, string | undefined> = {};
  let work: string;
  let runtime: FakeRuntime | undefined;

  beforeEach(() => {
    saved = { ...process.env };
    for (const name of MODEL_ENV_NAMES) delete process.env[name];
    work = fs.mkdtempSync(path.join(os.tmpdir(), "trent-app-embed-"));
    process.env.WIKI_EMBED_STORE = path.join(work, "wiki-embeddings.jsonl");
  });

  afterEach(async () => {
    await runtime?.close();
    runtime = undefined;
    fs.rmSync(work, { recursive: true, force: true });
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    for (const [name, value] of Object.entries(saved)) if (value !== undefined) process.env[name] = value;
    vi.resetModules();
  });

  it("writes EMBEDDING_MODEL from a local embedder on the runtime the alias routes the app to; an operator value wins", () => {
    process.env.OPENAI_BASE_URL = "http://127.0.0.1:11434/v1";
    const config = { provider: "ollama", memory: { embedder: { provider: "ollama" as const, model: "qwen3-embedding:0.6b" } } };
    expect(applyAppEmbeddingEnv(config)).toMatchObject({ written: ["EMBEDDING_MODEL"], kept: [] });
    expect(process.env.EMBEDDING_MODEL).toBe("qwen3-embedding:0.6b");
    process.env.EMBEDDING_MODEL = "operator-choice";
    expect(applyAppEmbeddingEnv(config)).toMatchObject({ written: [], kept: ["EMBEDDING_MODEL"] });
    expect(process.env.EMBEDDING_MODEL).toBe("operator-choice");
  });

  it("writes nothing under none, for a cloud embedder, or when the app's client points somewhere else", () => {
    process.env.OPENAI_BASE_URL = "http://127.0.0.1:11434/v1";
    expect(applyAppEmbeddingEnv({ provider: "ollama", memory: { embedder: { provider: "none" } } })).toMatchObject({ written: [], reason: "none" });
    expect(applyAppEmbeddingEnv({ provider: "google", memory: { embedder: { provider: "gemini" } } }).written).toEqual([]);
    process.env.OPENAI_BASE_URL = "http://127.0.0.1:1234/v1";
    expect(applyAppEmbeddingEnv({ provider: "lmstudio", memory: { embedder: { provider: "ollama" } } })).toMatchObject({ written: [], reason: "other_endpoint" });
    expect(process.env.EMBEDDING_MODEL).toBeUndefined();
  });

  it("applyModelEnv carries it: a profile with a local embedder leaves EMBEDDING_MODEL set for the app", () => {
    applyModelEnv({ provider: "ollama", model: "qwen3:4b", memory: { embedder: { provider: "ollama", model: "nomic-embed-text" } } } as ModelEnvConfig);
    expect(process.env.EMBEDDING_MODEL).toBe("nomic-embed-text");
  });

  it("the app's per-step wiki search asks the local runtime for the configured embedding model, never text-embedding-3-small", async () => {
    runtime = await fakeRuntime("qwen3-embedding:0.6b");
    process.env.OLLAMA_BASE_URL = `${runtime.url}/v1`;
    applyModelEnv({ provider: "ollama", model: "qwen3:4b", memory: { embedder: { provider: "auto" } } } as ModelEnvConfig);
    vi.resetModules();
    const wiki = await import("@/lib/wiki-embeddings");
    await wiki.semanticSearch({ companyId: "co_local", query: "what time does the bakery open on saturday" });
    expect(runtime.embeddings).toEqual([{ path: "/v1/embeddings", model: "qwen3-embedding:0.6b" }]);
  });

  it("under none the wrapper's embedder makes no request, and the app's call never leaves the loopback runtime", async () => {
    runtime = await fakeRuntime("qwen3-embedding:0.6b");
    process.env.OLLAMA_BASE_URL = `${runtime.url}/v1`;
    const config = { provider: "ollama", model: "qwen3:4b", memory: { embedder: { provider: "none" as const } } };
    applyModelEnv(config as ModelEnvConfig);
    expect(process.env.EMBEDDING_MODEL).toBeUndefined();
    let wrapperRequests = 0;
    const embedder = createEmbedder(config, {}, { fetchImpl: async () => { wrapperRequests += 1; return new Response("{}"); } });
    expect(embedder.provider).toBe("none");
    await embedder.embed(["alpha"]);
    expect(wrapperRequests).toBe(0);
    vi.resetModules();
    const wiki = await import("@/lib/wiki-embeddings");
    await wiki.semanticSearch({ companyId: "co_local", query: "what time does the bakery open on saturday" });
    expect(process.env.OPENAI_BASE_URL).toBe(`${runtime.url}/v1`);
    for (const call of runtime.embeddings) expect(call.path).toBe("/v1/embeddings");
  });
});
