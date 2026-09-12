import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigManager } from "../../config/ConfigManager.js";
import { checkCredentials } from "./credentials.js";
import type { DoctorContext } from "../types.js";

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

  it("fails when the active provider has no key at all", async () => {
    const result = await checkCredentials.run(context());
    expect(result.status).toBe("fail");
    expect(result.message).toContain("ANTHROPIC_API_KEY");
    expect(result.fixHint).toBeTruthy();
  });
});
