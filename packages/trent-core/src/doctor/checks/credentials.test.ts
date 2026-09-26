import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigManager } from "../../config/ConfigManager.js";
import { checkCredentials } from "./credentials.js";
import type { DoctorContext } from "../types.js";
import { CHAT_CAPS, fakeLocal } from "../../setup/local-fakes.test-helpers.js"; // [C9]

const REAL_SHAPED_ANTHROPIC = "sk-ant-api03-" + "z".repeat(95);
const PLACEHOLDER_ANTHROPIC = "sk-ant-placeh0ld"; // 16 chars, exactly what sits in ~/.trent/.env

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("credentials check", () => {
  let tempDir: string;
  let configManager: ConfigManager;

  const context = (over: Partial<DoctorContext> = {}): DoctorContext => ({
    baseDir: tempDir,
    profile: "default",
    configManager,
    probeTimeoutMs: 200,
    ...over,
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-creds-"));
    configManager = new ConfigManager({ baseDir: tempDir });
    configManager.ensureDirs();
    configManager.saveConfig({ ...configManager.loadConfig(), provider: "anthropic" });
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete process.env.ANTHROPIC_API_KEY;
  });

  function writeKey(value: string): void {
    fs.writeFileSync(configManager.getSecretsPath(), `ANTHROPIC_API_KEY=${value}\n`, { mode: 0o600 });
  }

  it("fails a 16-character sk-ant- placeholder and names its length", async () => {
    writeKey(PLACEHOLDER_ANTHROPIC);
    const result = await checkCredentials.run(
      context({ fetchImpl: async () => jsonResponse(200) }),
    );
    expect(result.status).toBe("fail");
    expect(result.message).toContain("16");
    expect(result.fixHint).toBeTruthy();
  });

  it("fails a well-formed key that the provider rejects with 401", async () => {
    writeKey(REAL_SHAPED_ANTHROPIC);
    const result = await checkCredentials.run(
      context({ fetchImpl: async () => jsonResponse(401, { error: "invalid x-api-key" }) }),
    );
    expect(result.status).toBe("fail");
    expect(result.message.toLowerCase()).toContain("reject");
  });

  it("passes a well-formed key the provider accepts", async () => {
    writeKey(REAL_SHAPED_ANTHROPIC);
    const result = await checkCredentials.run(
      context({ fetchImpl: async () => jsonResponse(200, { content: [] }) }),
    );
    expect(result.status).toBe("ok");
  });

  it("warns, not fails, when the provider host is unreachable", async () => {
    writeKey(REAL_SHAPED_ANTHROPIC);
    const result = await checkCredentials.run(
      context({
        fetchImpl: async () => {
          throw new TypeError("fetch failed");
        },
      }),
    );
    expect(result.status).toBe("warn");
    expect(result.message.toLowerCase()).toMatch(/offline|unreachable/);
  });

  it("completes within its timeout when the fetch never resolves", async () => {
    writeKey(REAL_SHAPED_ANTHROPIC);
    const started = Date.now();
    const result = await checkCredentials.run(
      context({ fetchImpl: () => new Promise<Response>(() => {}), probeTimeoutMs: 80 }),
    );
    expect(Date.now() - started).toBeLessThan(3000);
    expect(result.status).toBe("warn");
  });

  it("never leaks the key value, including in details", async () => {
    writeKey(REAL_SHAPED_ANTHROPIC);
    for (const fetchImpl of [
      async () => jsonResponse(200),
      async () => jsonResponse(401),
      async () => {
        throw new Error(`connect failed using ${REAL_SHAPED_ANTHROPIC}`);
      },
    ]) {
      const result = await checkCredentials.run(context({ fetchImpl }));
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(REAL_SHAPED_ANTHROPIC);
      expect(serialized).not.toContain("z".repeat(20));
    }
  });

  it("[P1-D] names the file the key resolved from, or the environment when it came from there", async () => {
    writeKey(REAL_SHAPED_ANTHROPIC);
    const fromFile = await checkCredentials.run(context({ fetchImpl: async () => jsonResponse(200) }));
    expect(fromFile.status).toBe("ok");
    expect(fromFile.message).toContain(configManager.getSecretsPath());

    // A profile with no file of its own, run with the key exported by the shell.
    const bare = new ConfigManager({ baseDir: tempDir, profile: "bare" });
    bare.saveConfig({ ...bare.loadConfig(), provider: "anthropic" });
    process.env.ANTHROPIC_API_KEY = REAL_SHAPED_ANTHROPIC;
    const fromEnv = await checkCredentials.run(context({ profile: "bare", configManager: bare, fetchImpl: async () => jsonResponse(200) }));
    expect(fromEnv.status).toBe("ok");
    expect(fromEnv.message).toContain("environment");
    expect(fromEnv.message).not.toContain(bare.getSecretsPath());
    expect(JSON.stringify([fromFile, fromEnv])).not.toContain(REAL_SHAPED_ANTHROPIC);
  });

  it("under a local provider says it runs locally with no key needed, and nothing else about keys", async () => {
    for (const provider of ["ollama", "lmstudio"] as const) {
      configManager.saveConfig({ ...configManager.loadConfig(), provider });
      const result = await checkCredentials.run(context({ fetchImpl: async () => { throw new Error("must not be called"); } }));
      expect(result.status).toBe("skip");
      expect(result.message).toContain(`Provider "${provider}" runs locally, no key needed`);
      expect(result.message).not.toMatch(/API key|_API_KEY|secrets/i);
      expect(result.fixHint).toBeUndefined();
    }
  });

  it("fails when the active provider has no key at all", async () => {
    // [C9] No local runtime answers (every origin refuses), so the hint is exactly today's.
    const result = await checkCredentials.run(context({ env: {}, fetchImpl: fakeLocal({}).fetch }));
    expect(result.status).toBe("fail");
    expect(result.message).toContain("ANTHROPIC_API_KEY");
    expect(result.fixHint).toBe("Run `trent config set ANTHROPIC_API_KEY <your-api-key>`."); // [C9]
  });

  // [C9] A keyless machine with a model on it: the hint names the local setup first.
  it("[C9] with no key and a local runtime that has a tools-capable model, the hint names trent setup --mode local", async () => {
    const ollama = fakeLocal({ ollama: { models: [{ name: "qwen3.5:9b", capabilities: [...CHAT_CAPS] }] } });
    const result = await checkCredentials.run(context({ env: {}, fetchImpl: ollama.fetch }));
    expect(result.status).toBe("fail");
    expect(result.message).toContain("ANTHROPIC_API_KEY");
    expect(result.fixHint).toMatch(/^Run `trent setup --mode local`/);
    expect(result.fixHint).toContain("qwen3.5:9b");
    expect(result.fixHint).toContain("http://127.0.0.1:11434");
    expect(result.fixHint).toContain("trent config set ANTHROPIC_API_KEY <your-api-key>");
    expect(result.details).toMatchObject({ suggested: "local" });
    // Only the runtime's read routes were asked; nothing reached a model.
    expect(ollama.calls.every((call) => call.startsWith("GET "))).toBe(true);
  });
});
