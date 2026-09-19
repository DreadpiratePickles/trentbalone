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
});
