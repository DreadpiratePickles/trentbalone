/**
 * [L1] The app's per-job timeout, sized for a local model.
 *
 * `apps/web/lib/queue.ts` `jobTimeoutMs` reads `TRENT_JOB_TIMEOUT_MS` per job and otherwise uses its
 * 10-minute default. L0-2's live run (docs/sessions/2026-09-26-l0-2-local-client.md) ended there: the
 * seat on qwen3.5:9b spent 157 s in prefill and was decoding at 3 tok/s when "Job ... timed out after
 * 600000ms". Under a local provider `applyModelEnv` now writes `models.local.job_timeout_seconds`
 * (default 1800) in milliseconds, unless the shell set the variable.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyModelEnv, type ModelEnvConfig } from "./model-env.js";

const KEYS = [
  "TRENT_JOB_TIMEOUT_MS", "MODEL_PREFERRED_PROVIDER", "OPENAI_BASE_URL", "OPENAI_API_KEY", "OLLAMA_API_KEY", "LMSTUDIO_API_KEY",
  "TRENT_MODEL_ALIAS", "MODEL_ALLOWED_PROVIDERS", "OPENAI_MODEL_FAST", "OPENAI_MODEL_DEFAULT", "OPENAI_MODEL_STRONG",
  "OPENAI_MODEL_CRITIC", "GOOGLE_MODEL_FAST", "GOOGLE_MODEL_DEFAULT", "GOOGLE_MODEL_STRONG", "WORKBENCH_EXECUTOR_MODEL",
  "WORKBENCH_PLANNER_MODEL", "EMBEDDING_MODEL",
];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function local(provider: string, jobTimeout?: number): ModelEnvConfig {
  return { provider, model: "qwen3.5:9b", ...(jobTimeout === undefined ? {} : { models: { local: { job_timeout_seconds: jobTimeout } } }) } as ModelEnvConfig;
}

describe("[L1] TRENT_JOB_TIMEOUT_MS under a local provider", () => {
  it("defaults to 1800 s for ollama and lmstudio, and says it wrote the variable", () => {
    const report = applyModelEnv(local("ollama"));
    expect(process.env.TRENT_JOB_TIMEOUT_MS).toBe("1800000");
    expect(report.written).toContain("TRENT_JOB_TIMEOUT_MS");
    delete process.env.TRENT_JOB_TIMEOUT_MS;
    applyModelEnv(local("lmstudio"));
    expect(process.env.TRENT_JOB_TIMEOUT_MS).toBe("1800000");
  });

  it("takes models.local.job_timeout_seconds", () => {
    applyModelEnv(local("ollama", 3600));
    expect(process.env.TRENT_JOB_TIMEOUT_MS).toBe("3600000");
  });

  it("keeps a value the shell set, and reports it kept", () => {
    process.env.TRENT_JOB_TIMEOUT_MS = "1234567";
    const report = applyModelEnv(local("ollama", 3600));
    expect(process.env.TRENT_JOB_TIMEOUT_MS).toBe("1234567");
    expect(report.kept).toContain("TRENT_JOB_TIMEOUT_MS");
  });

  it("leaves a hosted provider's job timeout to the app's default", () => {
    applyModelEnv({ provider: "google", model: "gemini-3.5-flash-lite" });
    expect(process.env.TRENT_JOB_TIMEOUT_MS).toBeUndefined();
  });
});
