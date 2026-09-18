import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyModelEnv, modelEnvKeys } from "./model-env.js";

const KEYS = [
  "MODEL_PREFERRED_PROVIDER",
  "GOOGLE_MODEL_FAST",
  "GOOGLE_MODEL_DEFAULT",
  "GOOGLE_MODEL_STRONG",
  "OPENAI_MODEL_FAST",
  "OPENAI_MODEL_DEFAULT",
  "OPENAI_MODEL_STRONG",
  "OPENAI_MODEL_CRITIC",
  "ANTHROPIC_MODEL_FAST",
  "ANTHROPIC_MODEL_DEFAULT",
  "ANTHROPIC_MODEL_STRONG",
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
  "OLLAMA_API_KEY",
  "LMSTUDIO_API_KEY",
  "DEEPSEEK_API_KEY",
  "GROQ_API_KEY",
  "TRENT_MODEL_ALIAS",
  "TRENT_MODEL_OVERRIDES",
  "WORKBENCH_EXECUTOR_MODEL",
  "WORKBENCH_PLANNER_MODEL",
] as const;
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

describe("applyModelEnv", () => {
  it("maps a Google config onto MODEL_PREFERRED_PROVIDER and every GOOGLE_MODEL_* tier", () => {
    const report = applyModelEnv({ provider: "google", model: "gemini-3.5-flash-lite" });
    expect(process.env.MODEL_PREFERRED_PROVIDER).toBe("google");
    expect(process.env.GOOGLE_MODEL_FAST).toBe("gemini-3.5-flash-lite");
    expect(process.env.GOOGLE_MODEL_DEFAULT).toBe("gemini-3.5-flash-lite");
    expect(process.env.GOOGLE_MODEL_STRONG).toBe("gemini-3.5-flash-lite");
    expect(report.written).toEqual(modelEnvKeys("google"));
    expect(process.env.TRENT_MODEL_OVERRIDES).toBeUndefined();
    expect(report.unsupportedProvider).toBe(false);
  });

  it("maps the OpenAI and Anthropic equivalents", () => {
    applyModelEnv({ provider: "openai", model: "gpt-4.1-mini" });
    expect(process.env.MODEL_PREFERRED_PROVIDER).toBe("openai");
    expect(process.env.OPENAI_MODEL_STRONG).toBe("gpt-4.1-mini");
    expect(process.env.OPENAI_MODEL_CRITIC).toBe("gpt-4.1-mini");
    delete process.env.MODEL_PREFERRED_PROVIDER;
    applyModelEnv({ provider: "Anthropic", model: "claude-sonnet-4-6" });
    expect(process.env.MODEL_PREFERRED_PROVIDER).toBe("anthropic");
    expect(process.env.ANTHROPIC_MODEL_DEFAULT).toBe("claude-sonnet-4-6");
  });

  it("never clobbers a variable the operator set explicitly", () => {
    process.env.GOOGLE_MODEL_STRONG = "gemini-3.6-pro";
    const report = applyModelEnv({ provider: "google", model: "gemini-3.5-flash-lite" });
    expect(process.env.GOOGLE_MODEL_STRONG).toBe("gemini-3.6-pro");
    expect(process.env.GOOGLE_MODEL_DEFAULT).toBe("gemini-3.5-flash-lite");
    expect(report.kept).toEqual(["GOOGLE_MODEL_STRONG"]);
  });

  it("routes a local alias through the app's OpenAI-compatible client instead of nowhere", () => {
    const report = applyModelEnv({ provider: "ollama", model: "llama3.2" });
    expect(report.unsupportedProvider).toBe(false);
    expect(report.unroutableProvider).toBeUndefined();
    expect(process.env.MODEL_PREFERRED_PROVIDER).toBe("openai");
    expect(process.env.OPENAI_BASE_URL).toBe("http://127.0.0.1:11434/v1");
    expect(process.env.OPENAI_MODEL_DEFAULT).toBe("llama3.2");
    expect(process.env.TRENT_MODEL_ALIAS).toBe("ollama");
    expect(modelEnvKeys("ollama")).toContain("OPENAI_BASE_URL");
  });

  it("routes a hosted alias that has its key", () => {
    process.env.DEEPSEEK_API_KEY = "sk-deepseek-test-key-0123456789";
    const report = applyModelEnv({ provider: "deepseek", model: "deepseek-chat" });
    expect(report.unsupportedProvider).toBe(false);
    expect(report.unroutableProvider).toBeUndefined();
    expect(process.env.OPENAI_BASE_URL).toBe("https://api.deepseek.com/v1");
  });

  it("refuses a hosted alias with no key, naming the variable and never a value", () => {
    const report = applyModelEnv({ provider: "groq", model: "llama-3.3-70b-versatile" });
    expect(report.unsupportedProvider).toBe(false);
    expect(report.unroutableProvider).toContain("GROQ_API_KEY");
    expect(process.env.MODEL_PREFERRED_PROVIDER).toBeUndefined();
  });

  it("still reports a provider nothing can route, and writes nothing", () => {
    const report = applyModelEnv({ provider: "vllm", model: "llama3" });
    expect(report.unsupportedProvider).toBe(true);
    expect(report.written).toEqual([]);
    expect(process.env.MODEL_PREFERRED_PROVIDER).toBeUndefined();
  });

  it("carries model_overrides to the gateway on the same bridge, whatever the provider is", () => {
    const report = applyModelEnv({
      provider: "google",
      model: "gemini-3.5-flash-lite",
      overrides: { "gemini-3.5-flash-lite": { input_cents_per_million: 30 } },
    });
    expect(report.written).toContain("TRENT_MODEL_OVERRIDES");
    expect(JSON.parse(process.env.TRENT_MODEL_OVERRIDES ?? "{}")).toEqual({
      "gemini-3.5-flash-lite": { input_cents_per_million: 30 },
    });
  });

  it("is a no-op without a config", () => {
    expect(applyModelEnv(undefined)).toEqual({ written: [], kept: [], unsupportedProvider: false });
  });
});

describe("createOrchestrator reads unsupportedProvider — the silent-route defect (D-7)", () => {
  it("fails with a typed config error (exit code 3) instead of quietly routing somewhere else", async () => {
    const { createOrchestrator } = await import("./index.js");
    const { isTrentError, EXIT } = await import("../errors/index.js");

    let thrown: unknown;
    try {
      createOrchestrator({ model: { provider: "vllm", model: "llama3" } });
    } catch (error) {
      thrown = error;
    }

    expect(isTrentError(thrown)).toBe(true);
    if (!isTrentError(thrown)) return;
    expect(thrown.code).toBe(EXIT.CONFIG);
    expect(thrown.message).toContain("vllm");
    expect(thrown.message).toMatch(/provider/i);
  });

  it("fails the same way when a known alias has no key to route with", async () => {
    const { createOrchestrator } = await import("./index.js");
    const { isTrentError, EXIT } = await import("../errors/index.js");
    let thrown: unknown;
    try {
      createOrchestrator({ model: { provider: "groq", model: "llama-3.3-70b-versatile" } });
    } catch (error) {
      thrown = error;
    }
    expect(isTrentError(thrown)).toBe(true);
    if (!isTrentError(thrown)) return;
    expect(thrown.code).toBe(EXIT.CONFIG);
    expect(thrown.message).toContain("GROQ_API_KEY");
  });

  it("builds normally for an alias the gateway can route", async () => {
    const { createOrchestrator } = await import("./index.js");
    expect(() => createOrchestrator({ model: { provider: "ollama", model: "llama3.2" } })).not.toThrow();
  });
});
