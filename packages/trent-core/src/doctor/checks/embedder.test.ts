/**
 * The recall-embedder check (C3): which ranker fleet recall is actually running, proven by one
 * cheap embedding call on the configured key — the same shape the credentials check uses.
 * Nothing here reaches a network: every request is served by an injected `fetchImpl`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigManager } from "../../config/ConfigManager.js";
import { DEFAULT_CHECKS } from "../DoctorRunner.js";
import type { DoctorContext } from "../types.js";
import { CALIBRATION_TRIPLES, RECORDED_LOCAL_FLOORS } from "../../fleet-memory/embedder-calibration.js";
import { checkEmbedder } from "./embedder.js";

const GEMINI_KEY = `AIza${"g".repeat(35)}`;
const ENV_KEYS = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "OPENAI_API_KEY"];

function embeddingResponse(dims: number): Response {
  return new Response(
    JSON.stringify({ data: [{ index: 0, embedding: Array.from({ length: dims }, () => 0.5) }] }),
    { status: 200 },
  );
}

describe("embedder check", () => {
  let tempDir: string;
  let configManager: ConfigManager;
  const saved = new Map<string, string | undefined>();

  const context = (over: Partial<DoctorContext> = {}): DoctorContext => ({
    baseDir: tempDir,
    profile: "default",
    configManager,
    probeTimeoutMs: 200,
    ...over,
  });

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-embedder-check-"));
    configManager = new ConfigManager({ baseDir: tempDir });
    configManager.ensureDirs();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
  });

  function writeKey(value: string): void {
    fs.writeFileSync(configManager.getSecretsPath(), `GEMINI_API_KEY=${value}\n`, { mode: 0o600 });
  }

  it("is part of the default check list", () => {
    expect(DEFAULT_CHECKS.map((check) => check.id)).toContain("check_embedder");
  });

  it("says lexical only, and probes nothing, when no embedding key is configured", async () => {
    let called = false;
    const result = await checkEmbedder.run(context({
      fetchImpl: async () => {
        called = true;
        return embeddingResponse(4);
      },
    }));
    expect(result.status).toBe("skip");
    expect(result.message).toMatch(/lexical/i);
    expect(result.fixHint).toBeTruthy();
    expect(called).toBe(false);
  });

  it("names the active provider, model and dimensions once a key embeds", async () => {
    writeKey(GEMINI_KEY);
    const result = await checkEmbedder.run(context({ fetchImpl: async () => embeddingResponse(768) }));
    expect(result.status).toBe("ok");
    expect(result.message).toMatch(/gemini/i);
    expect(result.details?.dims).toBe(768);
    expect(result.details?.provider).toBe("gemini");
    expect(JSON.stringify(result)).not.toContain(GEMINI_KEY);
  });

  it("fails when the provider rejects the key", async () => {
    writeKey(GEMINI_KEY);
    const result = await checkEmbedder.run(context({
      fetchImpl: async () => new Response(JSON.stringify({ error: "invalid" }), { status: 401 }),
    }));
    expect(result.status).toBe("fail");
    expect(result.fixHint).toBeTruthy();
  });

  it("warns rather than fails when the endpoint is unreachable", async () => {
    writeKey(GEMINI_KEY);
    const result = await checkEmbedder.run(context({
      fetchImpl: async () => {
        throw new Error("fetch failed");
      },
    }));
    expect(result.status).toBe("warn");
    expect(result.fixHint).toBeTruthy();
  });

  it("reports an explicit none as a deliberate choice, not a missing key", async () => {
    writeKey(GEMINI_KEY);
    const config = configManager.loadConfig();
    configManager.saveConfig({ ...config, memory: { ...config.memory, embedder: { provider: "none", batch_size: 32 } } });
    const result = await checkEmbedder.run(context({ fetchImpl: async () => embeddingResponse(4) }));
    expect(result.status).toBe("skip");
    expect(result.message).toMatch(/lexical/i);
  });

  it("[L0-5] reports an explicit none as lexical only", async () => {
    const config = configManager.loadConfig();
    configManager.saveConfig({ ...config, memory: { ...config.memory, embedder: { provider: "none", batch_size: 32 } } });
    const result = await checkEmbedder.run(context({ fetchImpl: async () => embeddingResponse(4) }));
    expect(result.status).toBe("skip");
    expect(result.message).toMatch(/lexical only/i);
    expect(result.details).toMatchObject({ provider: "none", ranker: "lexical" });
  });

  it("[L0-5] a cloud 404 names the model instead of calling the provider unreachable", async () => {
    writeKey(GEMINI_KEY);
    const result = await checkEmbedder.run(context({ fetchImpl: async () => new Response(JSON.stringify({ error: "model not found" }), { status: 404 }) }));
    expect(result.status).toBe("warn");
    expect(result.message).toMatch(/gemini-embedding-001/);
    expect(result.message).not.toMatch(/could not be reached/);
    expect(result.fixHint).toMatch(/memory\.embedder\.model/);
  });
});

/**
 * [L0-5] A local embedder: is the runtime reachable, is the model pulled (and the pull line when it is
 * not), how many dimensions it returns, the calibrated floor, and how many of the three fixed triples
 * that floor gets right. Served by a fake Ollama; nothing leaves the process.
 */
describe("[L0-5] embedder check on a local runtime", () => {
  let tempDir: string;
  let configManager: ConfigManager;
  const related = new Set(CALIBRATION_TRIPLES.flatMap((t) => [t.anchor, t.paraphrase]));
  const MODEL = "qwen3-embedding:0.6b";

  const context = (fetchImpl: DoctorContext["fetchImpl"]): DoctorContext => ({ baseDir: tempDir, profile: "default", configManager, probeTimeoutMs: 500, env: {}, ...(fetchImpl === undefined ? {} : { fetchImpl }) });

  /** A fake Ollama: `/api/tags` lists `models`; `/api/embed` puts anchors with their paraphrases and unrelated lines apart. */
  function fakeOllama(models: string[], calls: string[] = []): NonNullable<DoctorContext["fetchImpl"]> {
    return async (url, init) => {
      calls.push(url);
      if (url.endsWith("/api/tags")) return new Response(JSON.stringify({ models: models.map((name) => ({ name, model: name })) }), { status: 200 });
      const body = JSON.parse(String(init?.body ?? "{}")) as { input: string[] };
      const vector = (text: string): number[] => ([...related].some((r) => text.endsWith(r)) ? [1, 0, 0, 0] : [0, 1, 0, 0]);
      return new Response(JSON.stringify({ embeddings: body.input.map(vector) }), { status: 200 });
    };
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-embedder-local-check-"));
    configManager = new ConfigManager({ baseDir: tempDir });
    configManager.ensureDirs();
    const config = configManager.loadConfig();
    configManager.saveConfig({ ...config, provider: "ollama", model: "qwen3:4b" });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("names the runtime, the model, its dimensions, the recorded floor and a 3/3 sanity score", async () => {
    const result = await checkEmbedder.run(context(fakeOllama([MODEL, "qwen3:4b"])));
    expect(result.status).toBe("ok");
    expect(result.details).toMatchObject({ provider: "ollama", model: MODEL, endpoint: "http://127.0.0.1:11434", reachable: true, modelPresent: true, dims: 4, floor: RECORDED_LOCAL_FLOORS[MODEL]!.queryFloor, floorSource: "recorded", sanity: 3, ranker: "hybrid" });
    expect(result.message).toMatch(/Ollama/);
    expect(result.message).toMatch(/4 dimensions/);
    expect(result.message).toMatch(/3\/3/);
  });

  it("says the runtime is not reachable, with the command that starts it", async () => {
    const result = await checkEmbedder.run(context(async () => {
      throw new TypeError("fetch failed");
    }));
    expect(result.status).toBe("warn");
    expect(result.details).toMatchObject({ provider: "ollama", reachable: false, ranker: "lexical" });
    expect(result.message).toMatch(/127\.0\.0\.1:11434/);
    expect(result.fixHint).toMatch(/ollama serve/);
  });

  it("gives the pull line when the model is not pulled, and asks for no embedding", async () => {
    const calls: string[] = [];
    const result = await checkEmbedder.run(context(fakeOllama(["qwen3:4b"], calls)));
    expect(result.status).toBe("warn");
    expect(result.details).toMatchObject({ reachable: true, modelPresent: false, ranker: "lexical" });
    expect(result.fixHint).toBe(`ollama pull ${MODEL}`);
    expect(calls.some((url) => url.endsWith("/api/embed"))).toBe(false);
  });
});
