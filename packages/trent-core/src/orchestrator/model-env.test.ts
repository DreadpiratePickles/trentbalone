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

  it("reports a provider the router does not know and writes nothing", () => {
    const report = applyModelEnv({ provider: "ollama", model: "llama3" });
    expect(report.unsupportedProvider).toBe(true);
    expect(process.env.MODEL_PREFERRED_PROVIDER).toBeUndefined();
  });

  it("is a no-op without a config", () => {
    expect(applyModelEnv(undefined)).toEqual({ written: [], kept: [], unsupportedProvider: false });
  });
});
