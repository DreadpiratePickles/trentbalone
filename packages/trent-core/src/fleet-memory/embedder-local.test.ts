/**
 * [L0-5] The local embedder (G9): Ollama's native `/api/embed`, LM Studio's and llama.cpp's
 * `/v1/embeddings`, selected by `memory.embedder.provider` or implied by a local chat alias, and never
 * asked for `text-embedding-3-small`. Batches, the (provider, model, task type) cache, dimensions, the
 * per-model prefixes, the split around an over-long input, the calibrated floor, and the one loud
 * failure that sends recall back to lexical.
 *
 * Every request is served by an injected `fetchImpl`. Nothing in this file touches a network.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scoreAgainstWithEvidence, type CalibratedEmbedFn } from "./lexical.js";
import { createEmbedder, selectEmbedderProvider, type EmbedderConfigSource } from "./embedder.js";
import { LOCAL_EMBEDDER_ROUTES, localModelProfile } from "./embedder-local.js";
import { CALIBRATION_TRIPLES, RECORDED_LOCAL_FLOORS, floorFromPairs } from "./embedder-calibration.js";
import { EmbedderConfigSchema } from "../config/sections/memory.js";

interface Seen {
  readonly url: string;
  readonly authorization: string;
  readonly body: { model: string; input: string[]; truncate?: boolean };
}

type Answer = (body: Seen["body"], url: string) => Response | undefined;

/** Serves both dialects: Ollama's `{embeddings}` on /api/embed, OpenAI's `{data}` elsewhere. */
function localServer(vectorFor: (text: string) => number[], answer?: Answer): { seen: Seen[]; fetchImpl: (url: string, init?: RequestInit) => Promise<Response> } {
  const seen: Seen[] = [];
  return {
    seen,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Seen["body"];
      seen.push({ url, authorization: new Headers(init?.headers ?? {}).get("authorization") ?? "", body });
      const custom = answer?.(body, url);
      if (custom !== undefined) return custom;
      const vectors = body.input.map(vectorFor);
      return url.endsWith("/api/embed")
        ? new Response(JSON.stringify({ model: body.model, embeddings: vectors }), { status: 200 })
        : new Response(JSON.stringify({ data: vectors.map((embedding, index) => ({ index, embedding })) }), { status: 200 });
    },
  };
}

const byLength = (text: string): number[] => [text.length, 1, 0];
/** A model with no recorded floor calibrates on its first call; those requests are not the ones under test. */
const CALIBRATION = CALIBRATION_TRIPLES.flatMap((t) => [t.anchor, t.paraphrase, t.unrelated]);
const real = (seen: readonly Seen[]): Seen[] => seen.filter((s) => !s.body.input.every((text) => CALIBRATION.some((c) => text.endsWith(c))));
const OLLAMA: EmbedderConfigSource = { memory: { embedder: { provider: "ollama" } } };

describe("[L0-5] G9: a local provider never asks for text-embedding-3-small", () => {
  it("a local chat alias with the embedder on auto resolves to that runtime's own embedding model", () => {
    const chosen = selectEmbedderProvider({ provider: "ollama" }, {}, {});
    expect(chosen.provider).toBe("ollama");
    expect(chosen.model).toBe(LOCAL_EMBEDDER_ROUTES.ollama.defaultModel);
    expect(chosen.model).not.toBe("text-embedding-3-small");
    expect(chosen.baseUrl).toBe("http://127.0.0.1:11434");
    expect(chosen.apiKeyEnv).toBeUndefined();
    const lmstudio = selectEmbedderProvider({ provider: "lmstudio" }, {}, {});
    expect(lmstudio.provider).toBe("lmstudio");
    expect(lmstudio.baseUrl).toBe("http://127.0.0.1:1234/v1");
  });

  it("an explicit openai embedder under a local chat alias still goes to the local runtime, not text-embedding-3-small", () => {
    const chosen = selectEmbedderProvider({ provider: "ollama", memory: { embedder: { provider: "openai" } } }, { OPENAI_API_KEY: `sk-${"o".repeat(45)}` }, {});
    expect(chosen.provider).toBe("ollama");
    expect(chosen.model).not.toBe("text-embedding-3-small");
  });

  it("names each runtime explicitly, honours base_url over the environment, and strips Ollama's /v1 for the native endpoint", () => {
    expect(selectEmbedderProvider({ memory: { embedder: { provider: "llamacpp" } } }, {}, {}).baseUrl).toBe("http://127.0.0.1:8080/v1");
    expect(selectEmbedderProvider(OLLAMA, {}, { OLLAMA_BASE_URL: "http://10.0.0.5:11434/v1/" }).baseUrl).toBe("http://10.0.0.5:11434");
    const configured = selectEmbedderProvider({ memory: { embedder: { provider: "ollama", base_url: "http://gpu-box:11434/" } } }, {}, { OLLAMA_BASE_URL: "http://10.0.0.5:11434/v1" });
    expect(configured.baseUrl).toBe("http://gpu-box:11434");
    expect(selectEmbedderProvider({ memory: { embedder: { provider: "lmstudio", base_url: "http://127.0.0.1:1234" } } }, {}, {}).baseUrl).toBe("http://127.0.0.1:1234/v1");
  });

  it("none stays none under a local alias; google is gemini's other name", () => {
    expect(selectEmbedderProvider({ provider: "ollama", memory: { embedder: { provider: "none" } } }, {}, {}).provider).toBe("none");
    expect(selectEmbedderProvider({ memory: { embedder: { provider: "google" } } }, { GEMINI_API_KEY: `AIza${"g".repeat(35)}` }, {}).provider).toBe("gemini");
  });

  it("reports the known dimensions and the recorded floors of the default model", () => {
    const embedder = createEmbedder(OLLAMA, {}, { env: {}, fetchImpl: localServer(byLength).fetchImpl });
    expect(embedder.provider).toBe("ollama");
    expect(embedder.dims).toBe(1024);
    const recorded = RECORDED_LOCAL_FLOORS[LOCAL_EMBEDDER_ROUTES.ollama.defaultModel]!;
    expect((embedder.embed as CalibratedEmbedFn).vectorFloor).toBe(recorded.vectorFloor);
    expect((embedder.embed as CalibratedEmbedFn).queryFloor).toBe(recorded.queryFloor);
  });
});

describe("[L0-5] local embedding requests", () => {
  let profileDir: string;
  beforeEach(() => {
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-embed-local-"));
  });
  afterEach(() => {
    fs.rmSync(profileDir, { recursive: true, force: true });
  });

  it("posts to Ollama's /api/embed with truncate false, in bounded batches, in input order, and sends no real key", async () => {
    const { seen, fetchImpl } = localServer(byLength);
    const config: EmbedderConfigSource = { memory: { embedder: { provider: "ollama", model: "nomic-embed-text", batch_size: 2 } } };
    const embedder = createEmbedder(config, { OPENAI_API_KEY: `sk-${"o".repeat(45)}` }, { env: {}, fetchImpl, profileDir });
    const texts = ["a", "bb", "ccc", "dddd", "eeeee"];
    expect(await embedder.embed(texts)).toEqual(texts.map(byLength));
    expect(real(seen).map((s) => s.url)).toEqual(Array(3).fill("http://127.0.0.1:11434/api/embed"));
    expect(real(seen).map((s) => s.body.input.length)).toEqual([2, 2, 1]);
    for (const s of seen) {
      expect(s.body).toMatchObject({ model: "nomic-embed-text", truncate: false });
      expect(s.authorization).not.toContain("sk-");
    }
  });

  it("posts the OpenAI dialect to LM Studio and llama.cpp", async () => {
    const { seen, fetchImpl } = localServer(byLength);
    await createEmbedder({ memory: { embedder: { provider: "lmstudio", model: "text-embedding-bge-m3" } } }, {}, { env: {}, fetchImpl }).embed(["alpha"]);
    await createEmbedder({ memory: { embedder: { provider: "llamacpp", model: "bge-m3" } } }, {}, { env: {}, fetchImpl }).embed(["alpha"]);
    expect(real(seen).map((s) => s.url)).toEqual(["http://127.0.0.1:1234/v1/embeddings", "http://127.0.0.1:8080/v1/embeddings"]);
    expect(real(seen)[0]!.body).toEqual({ model: "text-embedding-bge-m3", input: ["alpha"] });
  });

  it("caches by (provider, model, task type): a repeat is free, a model change or a role is a miss", async () => {
    const { seen, fetchImpl } = localServer(byLength);
    const make = (model: string) => createEmbedder({ memory: { embedder: { provider: "ollama", model } } }, {}, { env: {}, fetchImpl, profileDir });
    await make("nomic-embed-text").embed(["alpha", "beta"]);
    expect(await make("nomic-embed-text").embed(["beta", "alpha"])).toEqual([byLength("beta"), byLength("alpha")]);
    expect(real(seen)).toHaveLength(1);
    await make("bge-m3").embed(["alpha"]);
    await make("nomic-embed-text").embed(["alpha"], { roles: ["query"] });
    expect(real(seen)).toHaveLength(3);
    const before = seen.length;
    await make("nomic-embed-text").embed(["alpha"], { roles: ["query"] });
    expect(seen).toHaveLength(before);
  });

  it("applies each model's own query and document prefixes when roles are named, and none when they are not", async () => {
    const { seen, fetchImpl } = localServer(byLength);
    const qwen = createEmbedder(OLLAMA, {}, { env: {}, fetchImpl });
    expect(qwen.taskTypes).toBe(true);
    await qwen.embed(["the doc", "the question"], { roles: ["document", "query"] });
    expect(seen[0]!.body.input).toEqual(["the doc", `${localModelProfile("qwen3-embedding:0.6b").queryPrefix}the question`]);
    expect(seen[0]!.body.input[1]).toMatch(/^Instruct: .+\nQuery:the question$/);

    const nomic = createEmbedder({ memory: { embedder: { provider: "ollama", model: "nomic-embed-text:latest" } } }, {}, { env: {}, fetchImpl });
    await nomic.embed(["the doc", "the question"], { roles: ["document", "query"] });
    expect(real(seen)[1]!.body.input).toEqual(["search_document: the doc", "search_query: the question"]);
    await nomic.embed(["plain"]);
    expect(real(seen)[2]!.body.input).toEqual(["plain"]);

    const symmetric = createEmbedder(OLLAMA, {}, { env: {}, fetchImpl, taskTypes: false });
    expect(symmetric.taskTypes).toBe(false);
    expect((symmetric.embed as CalibratedEmbedFn).queryFloor).toBeUndefined();
    await symmetric.embed(["q"], { roles: ["query"] });
    expect(real(seen)[3]!.body.input).toEqual(["q"]);
  });

  it("splits around an over-long input instead of letting the runtime cut it, and averages the pieces", async () => {
    const LIMIT = 120;
    const tooLong = (): Response => new Response(JSON.stringify({ error: "the input length exceeds the context length" }), { status: 400 });
    const { seen, fetchImpl } = localServer((text) => [1, text.length], (body) => (body.input.some((t) => t.length > LIMIT) ? tooLong() : undefined));
    const embedder = createEmbedder({ memory: { embedder: { provider: "ollama", model: "bge-m3" } } }, {}, { env: {}, fetchImpl });
    const long = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega ".repeat(4).trim();
    const [short, whole] = await embedder.embed(["short text", long]);
    expect(short).toEqual([1, "short text".length]);
    expect(whole).toHaveLength(2);
    expect(Math.hypot(...whole!)).toBeCloseTo(1, 6);
    const accepted = real(seen).filter((s) => s.body.input.every((t) => t.length <= LIMIT)).flatMap((s) => s.body.input).filter((t) => t !== "short text");
    expect(accepted.join(" ").split(/\s+/)).toEqual(long.split(/\s+/));
  });

  it("carries a floor for a model it has no record of by calibrating once on the three fixed triples", async () => {
    // Anchors and paraphrases share a direction; unrelated sentences are orthogonal to them.
    const related = new Set(CALIBRATION_TRIPLES.flatMap((t) => [t.anchor, t.paraphrase]));
    const vectorFor = (text: string): number[] => (related.has(text.replace(/^search_(query|document): /, "")) ? [1, 0.2] : [0.3, 1]);
    const { seen, fetchImpl } = localServer(vectorFor);
    const embedder = createEmbedder({ memory: { embedder: { provider: "ollama", model: "an-unrecorded-embedder" } } }, {}, { env: {}, fetchImpl, profileDir });
    await embedder.embed(["alpha"]);
    const floor = (embedder.embed as CalibratedEmbedFn).vectorFloor!;
    const cos = (a: number[], b: number[]): number => (a[0]! * b[0]! + a[1]! * b[1]!) / (Math.hypot(...a) * Math.hypot(...b));
    expect(floor).toBe(floorFromPairs(CALIBRATION_TRIPLES.map(() => ({ near: 1, far: cos([1, 0.2], [0.3, 1]) }))));
    expect(floor).toBeGreaterThan(cos([1, 0.2], [0.3, 1]));
    const calls = seen.length;
    await createEmbedder({ memory: { embedder: { provider: "ollama", model: "an-unrecorded-embedder" } } }, {}, { env: {}, fetchImpl, profileDir }).embed(["alpha"]);
    expect(seen.length).toBe(calls); // the calibration sentences and "alpha" are all cached now
  });
});

describe("[L0-5] an unreachable local runtime fails loudly once, and recall is lexical", () => {
  it("one WARN line naming the runtime, the model and the fix; later calls in the cooldown make no request and say nothing", async () => {
    const lines: Array<{ event: string; fields: Record<string, unknown> }> = [];
    let requests = 0;
    let clock = 1_000_000;
    const embedder = createEmbedder(OLLAMA, {}, {
      env: {},
      fetchImpl: async () => {
        requests += 1;
        throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), { code: "ECONNREFUSED" }) });
      },
      sleep: async () => undefined,
      warn: (event, fields) => lines.push({ event, fields }),
      now: () => clock,
    });
    await expect(embedder.embed(["alpha"])).rejects.toThrow(/Ollama/);
    const first = requests;
    expect(first).toBeGreaterThan(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.event).toBe("embedder.local_unavailable");
    expect(lines[0]!.fields).toMatchObject({ provider: "ollama", model: "qwen3-embedding:0.6b", endpoint: "http://127.0.0.1:11434", fallback: "lexical" });
    expect(String(lines[0]!.fields.fix)).toMatch(/ollama serve/);

    const scored = await scoreAgainstWithEvidence("reduce churn", ["churn is down", "forklift seals"], embedder.embed);
    const lexical = await scoreAgainstWithEvidence("reduce churn", ["churn is down", "forklift seals"]);
    expect(scored.scores).toEqual(lexical.scores);
    expect(requests).toBe(first);
    expect(lines).toHaveLength(1);

    clock += 10 * 60_000; // past the cooldown it asks the runtime again; still down, it says nothing new
    await expect(embedder.embed(["alpha"])).rejects.toThrow();
    expect(requests).toBeGreaterThan(first);
    expect(lines).toHaveLength(1);
  });

  it("a model that is not pulled is named with the pull command, never reported as unreachable", async () => {
    const lines: Array<Record<string, unknown>> = [];
    const embedder = createEmbedder(OLLAMA, {}, {
      env: {},
      fetchImpl: async () => new Response(JSON.stringify({ error: 'model "qwen3-embedding:0.6b" not found, try pulling it first' }), { status: 404 }),
      warn: (_event, fields) => lines.push(fields),
    });
    await expect(embedder.embed(["alpha"])).rejects.toThrow(/404/);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.fix).toBe("ollama pull qwen3-embedding:0.6b");
    expect(lines[0]!.reason).toBe("model_missing");
  });
});

describe("[L0-5] the memory.embedder config keys", () => {
  it("accepts the local runtimes, google as gemini's other name, and a base_url; rejects a base_url that is not a URL", () => {
    for (const provider of ["ollama", "lmstudio", "llamacpp", "google", "gemini", "openai", "auto", "none"] as const) {
      expect(EmbedderConfigSchema.parse({ provider }).provider).toBe(provider);
    }
    expect(EmbedderConfigSchema.parse({ provider: "ollama", model: "qwen3-embedding:0.6b", base_url: "http://gpu-box:11434" })).toEqual({ provider: "ollama", model: "qwen3-embedding:0.6b", base_url: "http://gpu-box:11434", batch_size: 32 });
    expect(() => EmbedderConfigSchema.parse({ provider: "ollama", base_url: "gpu-box" })).toThrow();
    expect(() => EmbedderConfigSchema.parse({ provider: "vllm" })).toThrow();
  });
});
