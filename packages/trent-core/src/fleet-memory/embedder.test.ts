/**
 * The core embedder (C3) behind the existing `EmbedFn` seam: provider selection, the two
 * OpenAI-dialect endpoints, bounded batching, bounded retry, the content-addressed disk cache,
 * and the rule that a key never reaches a message, a details bag or a cache file.
 *
 * Every request here is served by an injected `fetchImpl`. Nothing in this file touches a network.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigManager } from "../config/ConfigManager.js";
import type { FleetMemoryHookOptions } from "./orchestrator-hook.js";
import { scoreAgainstWithEvidence, type CalibratedEmbedFn, type EmbedCallOptions } from "./lexical.js";
import {
  EMBEDDER_ROUTES,
  createEmbedder,
  embedderForProfile,
  selectEmbedderProvider,
  type EmbedderConfigSource,
} from "./embedder.js";

const GEMINI_KEY = `AIza${"g".repeat(35)}`;
const OPENAI_KEY = `sk-${"o".repeat(45)}`;

interface Recorded {
  readonly url: string;
  readonly authorization: string;
  readonly body: { model: string; input: string[] };
}

function recorder(vectorFor: (text: string) => number[]): {
  calls: Recorded[];
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
} {
  const calls: Recorded[] = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      const headers = new Headers(init?.headers ?? {});
      const body = JSON.parse(String(init?.body ?? "{}")) as { model: string; input: string[] };
      calls.push({ url, authorization: headers.get("authorization") ?? "", body });
      return new Response(
        JSON.stringify({
          data: body.input.map((text, index) => ({ index, embedding: vectorFor(text) })),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  };
}

/** A deterministic stand-in vector: length by text, so a mix-up in ordering is visible. */
const byLength = (text: string): number[] => [text.length, 1, 0];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

describe("provider selection", () => {
  const noEnv = {};

  it("auto with no key at all is lexical only", () => {
    expect(selectEmbedderProvider({}, {}, noEnv).provider).toBe("none");
    const embedder = createEmbedder({}, {}, { env: noEnv });
    expect(embedder.provider).toBe("none");
    expect(embedder.model).toBe("");
    expect(embedder.dims).toBe(0);
  });

  it("auto picks Gemini when only a Gemini key exists, and names the variable it read", () => {
    const chosen = selectEmbedderProvider({}, { GEMINI_API_KEY: GEMINI_KEY }, noEnv);
    expect(chosen.provider).toBe("gemini");
    expect(chosen.apiKeyEnv).toBe("GEMINI_API_KEY");
  });

  it("auto picks OpenAI when only an OpenAI key exists", () => {
    expect(selectEmbedderProvider({}, { OPENAI_API_KEY: OPENAI_KEY }, noEnv).provider).toBe("openai");
  });

  it("auto follows the configured chat provider when both keys exist", () => {
    const secrets = { GEMINI_API_KEY: GEMINI_KEY, OPENAI_API_KEY: OPENAI_KEY };
    expect(selectEmbedderProvider({ provider: "openai" }, secrets, noEnv).provider).toBe("openai");
    expect(selectEmbedderProvider({ provider: "google" }, secrets, noEnv).provider).toBe("gemini");
  });

  it("an explicit none is lexical even with a key on the machine", () => {
    const config: EmbedderConfigSource = { memory: { embedder: { provider: "none" } } };
    expect(selectEmbedderProvider(config, { GEMINI_API_KEY: GEMINI_KEY }, noEnv).provider).toBe("none");
  });

  it("an explicit provider with no key is lexical rather than a broken embedder", () => {
    const config: EmbedderConfigSource = { memory: { embedder: { provider: "gemini" } } };
    expect(selectEmbedderProvider(config, {}, noEnv).provider).toBe("none");
  });

  it("reads the key from the process environment when the secrets file has none", () => {
    const chosen = selectEmbedderProvider({}, {}, { GOOGLE_API_KEY: GEMINI_KEY });
    expect(chosen.provider).toBe("gemini");
    expect(chosen.apiKeyEnv).toBe("GOOGLE_API_KEY");
  });
});

describe("embedding requests", () => {
  let profileDir: string;

  beforeEach(() => {
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-embed-"));
  });

  afterEach(() => {
    fs.rmSync(profileDir, { recursive: true, force: true });
  });

  it("posts to the Gemini OpenAI-compatible embeddings endpoint with a bearer header", async () => {
    const { calls, fetchImpl } = recorder(byLength);
    const embedder = createEmbedder({}, { GEMINI_API_KEY: GEMINI_KEY }, { env: {}, fetchImpl, profileDir });
    expect(embedder.provider).toBe("gemini");
    expect(embedder.model).toBe(EMBEDDER_ROUTES.gemini.defaultModel);
    expect(embedder.dims).toBe(EMBEDDER_ROUTES.gemini.defaultDims);

    const vectors = await embedder.embed(["alpha", "beta beta"]);
    expect(vectors).toEqual([byLength("alpha"), byLength("beta beta")]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${EMBEDDER_ROUTES.gemini.defaultBaseUrl}/embeddings`);
    expect(calls[0]!.authorization).toBe(`Bearer ${GEMINI_KEY}`);
    expect(calls[0]!.body.model).toBe(EMBEDDER_ROUTES.gemini.defaultModel);
  });

  it("posts to the OpenAI endpoint, and an alias base URL wins over the default", async () => {
    const { calls, fetchImpl } = recorder(byLength);
    const direct = createEmbedder({}, { OPENAI_API_KEY: OPENAI_KEY }, { env: {}, fetchImpl, profileDir });
    await direct.embed(["alpha"]);
    expect(calls[0]!.url).toBe(`${EMBEDDER_ROUTES.openai.defaultBaseUrl}/embeddings`);

    // `model-gateway/providers.ts` already resolves the four OpenAI-dialect aliases; reused here.
    const aliased = createEmbedder(
      { provider: "groq" },
      { GROQ_API_KEY: `gsk_${"k".repeat(40)}` },
      { env: {}, fetchImpl, profileDir },
    );
    await aliased.embed(["alpha"]);
    expect(calls[1]!.url).toBe("https://api.groq.com/openai/v1/embeddings");
  });

  it("splits the corpus into bounded batches and returns vectors in input order", async () => {
    const { calls, fetchImpl } = recorder(byLength);
    const config: EmbedderConfigSource = { memory: { embedder: { batch_size: 2 } } };
    const embedder = createEmbedder(config, { GEMINI_API_KEY: GEMINI_KEY }, { env: {}, fetchImpl, profileDir });
    const texts = ["a", "bb", "ccc", "dddd", "eeeee"];
    const vectors = await embedder.embed(texts);
    expect(vectors).toEqual(texts.map(byLength));
    expect(calls).toHaveLength(3);
    expect(calls.map((c) => c.body.input.length)).toEqual([2, 2, 1]);
  });

  it("serves a repeat corpus from the content-addressed cache without a second request", async () => {
    const { calls, fetchImpl } = recorder(byLength);
    const make = () => createEmbedder({}, { GEMINI_API_KEY: GEMINI_KEY }, { env: {}, fetchImpl, profileDir });
    const first = await make().embed(["alpha", "beta"]);
    expect(calls).toHaveLength(1);
    const second = await make().embed(["beta", "alpha"]);
    expect(second).toEqual([first[1], first[0]]);
    expect(calls).toHaveLength(1);
  });

  it("creates the cache directory 0700 and writes no key into it", async () => {
    const { fetchImpl } = recorder(byLength);
    const embedder = createEmbedder({}, { GEMINI_API_KEY: GEMINI_KEY }, { env: {}, fetchImpl, profileDir });
    await embedder.embed(["alpha"]);
    const dir = path.join(profileDir, "cache", "embeddings");
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    const files = walk(dir);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(fs.readFileSync(file, "utf8")).not.toContain(GEMINI_KEY);
  });

  it("keys the cache on the model, so a model change is a miss", async () => {
    const { calls, fetchImpl } = recorder(byLength);
    const base: EmbedderConfigSource = { memory: { embedder: { model: "embed-one" } } };
    await createEmbedder(base, { GEMINI_API_KEY: GEMINI_KEY }, { env: {}, fetchImpl, profileDir }).embed(["alpha"]);
    const other: EmbedderConfigSource = { memory: { embedder: { model: "embed-two" } } };
    await createEmbedder(other, { GEMINI_API_KEY: GEMINI_KEY }, { env: {}, fetchImpl, profileDir }).embed(["alpha"]);
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.body.model)).toEqual(["embed-one", "embed-two"]);
  });

  it("retries a 429 under the gateway's bounded policy and never sleeps in the test", async () => {
    const slept: number[] = [];
    let attempts = 0;
    const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => {
      attempts += 1;
      if (attempts === 1) return new Response("slow down", { status: 429, headers: { "retry-after": "1" } });
      const body = JSON.parse(String(init?.body ?? "{}")) as { input: string[] };
      return new Response(
        JSON.stringify({ data: body.input.map((t, index) => ({ index, embedding: byLength(t) })) }),
        { status: 200 },
      );
    };
    const embedder = createEmbedder({}, { GEMINI_API_KEY: GEMINI_KEY }, {
      env: {},
      fetchImpl,
      profileDir,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(await embedder.embed(["alpha"])).toEqual([byLength("alpha")]);
    expect(attempts).toBe(2);
    expect(slept).toEqual([1000]);
  });

  it("does not retry a 400 and never puts the key in the error", async () => {
    let attempts = 0;
    const fetchImpl = async (): Promise<Response> => {
      attempts += 1;
      return new Response(`bad request for key ${GEMINI_KEY}`, { status: 400 });
    };
    const embedder = createEmbedder({}, { GEMINI_API_KEY: GEMINI_KEY }, { env: {}, fetchImpl, profileDir });
    const failure = await embedder.embed(["alpha"]).then(() => undefined, (e: unknown) => e as Error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure!.message).toContain("400");
    expect(failure!.message).not.toContain(GEMINI_KEY);
    expect(attempts).toBe(1);
  });

  it("gives up with a typed failure when the response is not an embedding list", async () => {
    const fetchImpl = async (): Promise<Response> => new Response(JSON.stringify({ data: [] }), { status: 200 });
    const embedder = createEmbedder({}, { GEMINI_API_KEY: GEMINI_KEY }, { env: {}, fetchImpl, profileDir });
    await expect(embedder.embed(["alpha"])).rejects.toThrow(/embedding/i);
  });

  it("the lexical fallback embeds offline and asks for no request at all", async () => {
    let called = false;
    const embedder = createEmbedder({}, {}, {
      env: {},
      profileDir,
      fetchImpl: async () => {
        called = true;
        return new Response("", { status: 500 });
      },
    });
    const vectors = await embedder.embed(["alpha beta", "alpha gamma"]);
    expect(vectors).toHaveLength(2);
    expect(called).toBe(false);
  });
});

describe("embedderForProfile", () => {
  let baseDir: string;
  let configManager: ConfigManager;
  const savedEnv = new Map<string, string | undefined>();
  const ENV_KEYS = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "OPENAI_API_KEY"];

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-embed-profile-"));
    configManager = new ConfigManager({ baseDir });
    configManager.ensureDirs();
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    savedEnv.clear();
  });

  it("is undefined with no key, so recall stays exactly as lexical as it was", () => {
    expect(embedderForProfile(configManager)).toBeUndefined();
  });

  it("is an EmbedFn once a key is in the profile secrets", () => {
    fs.writeFileSync(configManager.getSecretsPath(), `GEMINI_API_KEY=${GEMINI_KEY}\n`, { mode: 0o600 });
    expect(typeof embedderForProfile(configManager)).toBe("function");
  });

  it("is accepted as the hook's own `embed` option, which is the whole wiring change", () => {
    // `embed: embedderForProfile(configManager)` has to compile at the call site; this is that
    // call site, so a signature change on either side fails here rather than in someone's REPL.
    const off: FleetMemoryHookOptions["embed"] = embedderForProfile(configManager);
    expect(off).toBeUndefined();
    // A fresh manager, because `loadSecrets` caches for the life of one.
    fs.writeFileSync(configManager.getSecretsPath(), `GEMINI_API_KEY=${GEMINI_KEY}\n`, { mode: 0o600 });
    const on: FleetMemoryHookOptions["embed"] = embedderForProfile(new ConfigManager({ baseDir }));
    expect(typeof on).toBe("function");
  });
});

/**
 * [P2-13] Asymmetric task types. Google's OpenAI-compatible surface takes no task type, so a call
 * that names a role per text goes to the native `batchEmbedContents` with RETRIEVAL_QUERY or
 * RETRIEVAL_DOCUMENT on each request. A call that names none is the request it always was, so run
 * recall, search, the failure index and the doctor probe are unchanged.
 */
describe("[P2-13] task types on the Gemini route", () => {
  let profileDir: string;

  beforeEach(() => {
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-embed-tt-"));
  });

  afterEach(() => {
    fs.rmSync(profileDir, { recursive: true, force: true });
  });

  interface NativeCall {
    readonly url: string;
    readonly apiKeyHeader: string;
    readonly authorization: string;
    readonly body: { requests?: Array<{ model: string; content: { parts: Array<{ text: string }> }; taskType: string }>; input?: string[] };
  }

  /** Serves both dialects: the native batch (`embeddings[].values`) and the compatible one (`data[]`). */
  function bothDialects(vectorFor: (text: string, taskType?: string) => number[]): { calls: NativeCall[]; fetchImpl: (url: string, init?: RequestInit) => Promise<Response> } {
    const calls: NativeCall[] = [];
    return {
      calls,
      fetchImpl: async (url, init) => {
        const headers = new Headers(init?.headers ?? {});
        const body = JSON.parse(String(init?.body ?? "{}")) as NativeCall["body"];
        calls.push({ url, apiKeyHeader: headers.get("x-goog-api-key") ?? "", authorization: headers.get("authorization") ?? "", body });
        if (body.requests !== undefined) {
          return new Response(JSON.stringify({ embeddings: body.requests.map((r) => ({ values: vectorFor(r.content.parts[0]!.text, r.taskType) })) }), { status: 200 });
        }
        return new Response(JSON.stringify({ data: (body.input ?? []).map((t, index) => ({ index, embedding: vectorFor(t) })) }), { status: 200 });
      },
    };
  }

  const byRole = (text: string, taskType?: string): number[] => [text.length, taskType === "RETRIEVAL_QUERY" ? 2 : taskType === "RETRIEVAL_DOCUMENT" ? 3 : 1];

  it("sends a call with roles to the native batchEmbedContents, one taskType per text, the key in a header and never the URL", async () => {
    const { calls, fetchImpl } = bothDialects(byRole);
    const embedder = createEmbedder({}, { GEMINI_API_KEY: GEMINI_KEY }, { env: {}, fetchImpl, profileDir, taskTypes: true });
    const vectors = await embedder.embed(["doc one", "doc two!", "the query"], { roles: ["document", "document", "query"] });

    expect(vectors).toEqual([byRole("doc one", "RETRIEVAL_DOCUMENT"), byRole("doc two!", "RETRIEVAL_DOCUMENT"), byRole("the query", "RETRIEVAL_QUERY")]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents");
    expect(calls[0]!.url).not.toContain(GEMINI_KEY);
    expect(calls[0]!.apiKeyHeader).toBe(GEMINI_KEY);
    expect(calls[0]!.authorization).toBe("");
    expect(calls[0]!.body.requests).toEqual([
      { model: "models/gemini-embedding-001", content: { parts: [{ text: "doc one" }] }, taskType: "RETRIEVAL_DOCUMENT" },
      { model: "models/gemini-embedding-001", content: { parts: [{ text: "doc two!" }] }, taskType: "RETRIEVAL_DOCUMENT" },
      { model: "models/gemini-embedding-001", content: { parts: [{ text: "the query" }] }, taskType: "RETRIEVAL_QUERY" },
    ]);
  });

  it("a call with no roles is the OpenAI-compatible request it always was", async () => {
    const { calls, fetchImpl } = bothDialects(byRole);
    const embedder = createEmbedder({}, { GEMINI_API_KEY: GEMINI_KEY }, { env: {}, fetchImpl, profileDir });
    expect(await embedder.embed(["alpha"])).toEqual([byRole("alpha")]);
    expect(calls[0]!.url).toBe(`${EMBEDDER_ROUTES.gemini.defaultBaseUrl}/embeddings`);
    expect(calls[0]!.body).toEqual({ model: "gemini-embedding-001", input: ["alpha"] });
  });

  it("keys the cache by task type: one text as a query and as a document is two vectors, and neither answers a call with no roles", async () => {
    const { calls, fetchImpl } = bothDialects(byRole);
    const make = () => createEmbedder({}, { GEMINI_API_KEY: GEMINI_KEY }, { env: {}, fetchImpl, profileDir, taskTypes: true });
    const asDocument = await make().embed(["alpha"], { roles: ["document"] });
    const asQuery = await make().embed(["alpha"], { roles: ["query"] });
    const plain = await make().embed(["alpha"]);
    expect([asDocument[0], asQuery[0], plain[0]]).toEqual([byRole("alpha", "RETRIEVAL_DOCUMENT"), byRole("alpha", "RETRIEVAL_QUERY"), byRole("alpha")]);
    expect(calls).toHaveLength(3);
    // Each is now cached under its own task type.
    expect(await make().embed(["alpha", "alpha"], { roles: ["query", "document"] })).toEqual([asQuery[0], asDocument[0]]);
    expect(await make().embed(["alpha"])).toEqual(plain);
    expect(calls).toHaveLength(3);
  });

  it("carries the task-typed floor only where task types apply; the default, OpenAI and a foreign base URL ignore roles", async () => {
    const { calls, fetchImpl } = bothDialects(byRole);
    const gemini = createEmbedder({}, { GEMINI_API_KEY: GEMINI_KEY }, { env: {}, fetchImpl, profileDir, taskTypes: true });
    expect((gemini.embed as CalibratedEmbedFn).queryFloor).toBe(EMBEDDER_ROUTES.gemini.queryFloor);
    expect((gemini.embed as CalibratedEmbedFn).vectorFloor).toBe(EMBEDDER_ROUTES.gemini.vectorFloor);
    expect(gemini.taskTypes).toBe(true);

    // Off by default until the docs corpus measures them (the re-embed met the free tier's daily quota).
    const openai = createEmbedder({}, { OPENAI_API_KEY: OPENAI_KEY }, { env: {}, fetchImpl, profileDir, taskTypes: true });
    const off = createEmbedder({}, { GEMINI_API_KEY: GEMINI_KEY }, { env: {}, fetchImpl, profileDir });
    const proxied = createEmbedder({}, { GEMINI_API_KEY: GEMINI_KEY }, { env: { GEMINI_BASE_URL: "https://proxy.example/v1" }, fetchImpl, profileDir, taskTypes: true });
    for (const embedder of [openai, off, proxied]) {
      expect((embedder.embed as CalibratedEmbedFn).queryFloor).toBeUndefined();
      expect(embedder.taskTypes).toBe(false);
      await embedder.embed(["beta"], { roles: ["query"] });
    }
    expect(calls.map((c) => c.url)).toEqual([
      `${EMBEDDER_ROUTES.openai.defaultBaseUrl}/embeddings`,
      `${EMBEDDER_ROUTES.gemini.defaultBaseUrl}/embeddings`,
      "https://proxy.example/v1/embeddings",
    ]);
  });

  it("a native response with the wrong number of vectors is a typed failure, not a silent misalignment", async () => {
    const fetchImpl = async (): Promise<Response> => new Response(JSON.stringify({ embeddings: [{ values: [1, 0] }] }), { status: 200 });
    const embedder = createEmbedder({}, { GEMINI_API_KEY: GEMINI_KEY }, { env: {}, fetchImpl, profileDir, taskTypes: true });
    await expect(embedder.embed(["a", "b"], { roles: ["document", "query"] })).rejects.toThrow(/embedding/i);
  });

  it("the scorer asks for roles only when told the ranking is asymmetric, and then uses the task-typed floor", async () => {
    const seen: Array<{ texts: readonly string[]; roles: readonly string[] | undefined }> = [];
    const spy: CalibratedEmbedFn = Object.assign(
      async (texts: readonly string[], options?: EmbedCallOptions) => {
        seen.push({ texts, roles: options?.roles });
        return texts.map((_, i) => (i === texts.length - 1 ? [1, 0] : [0.7, Math.sqrt(1 - 0.49)]));
      },
      { vectorFloor: 0.6, queryFloor: 0.75 },
    );
    const symmetric = await scoreAgainstWithEvidence("q", ["a", "b"], spy);
    const asymmetric = await scoreAgainstWithEvidence("q", ["a", "b"], spy, { asymmetric: true });
    expect(seen.map((s) => s.roles)).toEqual([undefined, ["document", "document", "query"]]);
    // cosine 0.7 clears the symmetric floor (0.6) and not the task-typed one (0.75).
    expect(symmetric.vectorRelated).toEqual([true, true]);
    expect(asymmetric.vectorRelated).toEqual([false, false]);
  });
});
