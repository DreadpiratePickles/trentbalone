import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyModelEnv, modelEnvKeys, resolveSeatModel, seatTierVar } from "./model-env.js";

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

  it("B2: writes the configured tiers into the tier variables instead of one model into all three", () => {
    const report = applyModelEnv({
      provider: "google",
      model: "gemini-3.5-flash-lite",
      models: { fast: "gemini-3.5-flash-lite", executor: "gemini-3.5-pro", planner: "gemini-3.5-ultra" },
    });
    expect(process.env.GOOGLE_MODEL_FAST).toBe("gemini-3.5-flash-lite");
    expect(process.env.GOOGLE_MODEL_DEFAULT).toBe("gemini-3.5-pro");
    expect(process.env.GOOGLE_MODEL_STRONG).toBe("gemini-3.5-ultra");
    expect(report.written).toEqual(expect.arrayContaining(["GOOGLE_MODEL_FAST", "GOOGLE_MODEL_DEFAULT", "GOOGLE_MODEL_STRONG"]));
  });

  it("B2: a tier nothing configures falls back to the executor model, and then to the one model", () => {
    applyModelEnv({ provider: "anthropic", model: "claude-sonnet-4-6", models: { executor: "claude-sonnet-4-7" } });
    expect(process.env.ANTHROPIC_MODEL_FAST).toBe("claude-sonnet-4-7");
    expect(process.env.ANTHROPIC_MODEL_DEFAULT).toBe("claude-sonnet-4-7");
    expect(process.env.ANTHROPIC_MODEL_STRONG).toBe("claude-sonnet-4-7");
  });

  it("B2: the A0.3 alias still resolves to openai plus a base URL, and carries its tiers", () => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    const report = applyModelEnv({
      provider: "deepseek",
      model: "deepseek-chat",
      models: { executor: "deepseek-chat", planner: "deepseek-reasoner" },
    });
    expect(report.unsupportedProvider).toBe(false);
    expect(report.unroutableProvider).toBeUndefined();
    expect(process.env.MODEL_PREFERRED_PROVIDER).toBe("openai");
    expect(process.env.OPENAI_BASE_URL).toContain("deepseek");
    expect(process.env.OPENAI_MODEL_DEFAULT).toBe("deepseek-chat");
    expect(process.env.OPENAI_MODEL_STRONG).toBe("deepseek-reasoner");
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

describe("resolveSeatModel — a seat's manifest tier picks its model (B2)", () => {
  const twoTiers = { provider: "google", model: "gemini-3.5-pro", models: { executor: "gemini-3.5-pro", planner: "gemini-3.5-ultra" } };
  const oneTier = { provider: "google", model: "gemini-3.5-pro", models: { executor: "gemini-3.5-pro" } };

  it("names the variable the app's resolver reads for that seat's tier", () => {
    // engineer is the sonnet tier -> DEFAULT; ceo is the opus tier -> STRONG.
    expect(seatTierVar("engineer", "google")).toBe("GOOGLE_MODEL_DEFAULT");
    expect(seatTierVar("ceo", "google")).toBe("GOOGLE_MODEL_STRONG");
    expect(seatTierVar("support", "anthropic")).toBe("ANTHROPIC_MODEL_FAST");
  });

  it("with two configured tiers, engineer and ceo resolve different models", () => {
    applyModelEnv(twoTiers);
    expect(resolveSeatModel("engineer", twoTiers)).toBe("gemini-3.5-pro");
    expect(resolveSeatModel("ceo", twoTiers)).toBe("gemini-3.5-ultra");
    expect(resolveSeatModel("engineer", twoTiers)).not.toBe(resolveSeatModel("ceo", twoTiers));
  });

  it("with one configured tier, both resolve the same model", () => {
    applyModelEnv(oneTier);
    expect(resolveSeatModel("engineer", oneTier)).toBe("gemini-3.5-pro");
    expect(resolveSeatModel("ceo", oneTier)).toBe(resolveSeatModel("engineer", oneTier));
  });

  it("an operator's explicit tier variable still wins over the config file", () => {
    process.env.GOOGLE_MODEL_STRONG = "gemini-operator-choice";
    applyModelEnv(twoTiers);
    expect(resolveSeatModel("ceo", twoTiers)).toBe("gemini-operator-choice");
  });
});
