import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigManager } from "../../config/ConfigManager.js";
import { checkEnvironment } from "./environment.js";
import type { DoctorContext } from "../types.js";

let tempDir: string;
let configManager: ConfigManager;

const context = (): DoctorContext => ({
  baseDir: tempDir,
  profile: "default",
  configManager,
});

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-env-"));
  configManager = new ConfigManager({ baseDir: tempDir });
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("environment contract check", () => {
  it("fails when TRENT_QUEUE_FALLBACK is not disabled, and states the consequence", async () => {
    vi.stubEnv("TRENT_QUEUE_FALLBACK", "");
    vi.stubEnv("REDIS_URL", "");
    const result = await checkEnvironment.run(context());
    expect(result.status).toBe("fail");
    expect(result.message).toContain("TRENT_QUEUE_FALLBACK");
    expect(result.message).toMatch(/twice/i);
    expect(result.message).toMatch(/bill/i);
    expect(result.fixHint).toContain("TRENT_QUEUE_FALLBACK=disabled");
  });

  it("fails when a Redis variable is set", async () => {
    vi.stubEnv("TRENT_QUEUE_FALLBACK", "disabled");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    const result = await checkEnvironment.run(context());
    expect(result.status).toBe("fail");
    expect(result.message).toContain("REDIS_URL");
  });

  it("fails when TRENT_EVAL_SYNC_QUEUE is set", async () => {
    vi.stubEnv("TRENT_QUEUE_FALLBACK", "disabled");
    vi.stubEnv("REDIS_URL", "");
    vi.stubEnv("TRENT_EVAL_SYNC_QUEUE", "1");
    const result = await checkEnvironment.run(context());
    expect(result.status).toBe("fail");
    expect(result.message).toContain("TRENT_EVAL_SYNC_QUEUE");
  });

  it("passes when the contract holds", async () => {
    vi.stubEnv("TRENT_QUEUE_FALLBACK", "disabled");
    vi.stubEnv("REDIS_URL", "");
    vi.stubEnv("TRENT_EVAL_SYNC_QUEUE", "");
    const result = await checkEnvironment.run(context());
    expect(result.status).toBe("ok");
  });

  it("never puts an environment value in the result, only variable names", async () => {
    vi.stubEnv("TRENT_QUEUE_FALLBACK", "disabled");
    vi.stubEnv("REDIS_URL", "redis://user:hunter2@localhost:6379");
    const result = await checkEnvironment.run(context());
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });
});
