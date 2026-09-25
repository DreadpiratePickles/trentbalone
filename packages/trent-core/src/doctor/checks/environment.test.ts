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
    expect(result.fixHint).toMatch(/^Unset TRENT_QUEUE_FALLBACK or set it to disabled/);
  });

  // Since 499cd14 the CLI sets TRENT_QUEUE_FALLBACK=disabled itself when it is unset
  // (apps/cli/src/env-defaults.ts), so a failure here means an explicit value: "Export" was wrong.
  it("tells an explicit bad TRENT_QUEUE_FALLBACK to unset it or set it to disabled, never to export it", async () => {
    vi.stubEnv("TRENT_QUEUE_FALLBACK", "inline");
    vi.stubEnv("REDIS_URL", "");
    vi.stubEnv("TRENT_EVAL_SYNC_QUEUE", "");
    const result = await checkEnvironment.run(context());
    expect(result.status).toBe("fail");
    expect(result.fixHint).toBe("Unset TRENT_QUEUE_FALLBACK or set it to disabled (the CLI sets disabled itself when it is unset) before running Trent.");
    expect(result.fixHint).not.toMatch(/export/i);
  });

  it("names only the variables that are wrong", async () => {
    vi.stubEnv("TRENT_QUEUE_FALLBACK", "disabled");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    vi.stubEnv("TRENT_EVAL_SYNC_QUEUE", "1");
    const result = await checkEnvironment.run(context());
    expect(result.fixHint).toBe("Unset TRENT_EVAL_SYNC_QUEUE and REDIS_URL before running Trent.");
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
