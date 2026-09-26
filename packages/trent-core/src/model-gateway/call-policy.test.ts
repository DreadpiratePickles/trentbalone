/**
 * [P1-C] The two per-call policies the `models` block adds: whether a pinned model may fall back,
 * and the reasoning effort sent with the call. They reach a gateway built with no arguments (the
 * orchestrator's) the same way `model_overrides` does: an env bridge written from config.
 */
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../config/defaults.js";
import { TrentConfigSchema } from "../config/schema.js";
import { ModelTiersConfigSchema } from "../config/sections/models.js";
import { applyModelEnv } from "../orchestrator/model-env.js";
import {
  MODEL_CALL_ENV,
  REASONING_EFFORTS,
  applyModelCallEnv,
  isLocalModel,
  modelCallPolicyFromEnv,
  modelHostingLabel,
  planAttempts,
} from "./call-policy.js";
import { ALIAS_ENV } from "./providers.js";
import type { ModelProvider } from "./types.js";

const saved = { ...process.env };
const TOUCHED = [...Object.values(MODEL_CALL_ENV), "MODEL_PREFERRED_PROVIDER", "GOOGLE_MODEL_FAST", "GOOGLE_MODEL_DEFAULT", "GOOGLE_MODEL_STRONG"];
afterEach(() => {
  for (const name of TOUCHED) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe("models.fallback_on_pin and models.reasoning_effort in config", () => {
  it("accepts both keys, and an untouched profile carries neither (fallback off, effort omitted)", () => {
    const parsed = TrentConfigSchema.parse({ ...DEFAULT_CONFIG, models: { fallback_on_pin: true, reasoning_effort: "low" } });
    expect(parsed.models).toEqual({ fallback_on_pin: true, reasoning_effort: "low" });
    const plain = TrentConfigSchema.parse(DEFAULT_CONFIG);
    expect(plain.models).toEqual({});
  });

  it("refuses an effort Google does not accept, rather than sending it and taking a 400 mid-run", () => {
    expect(() => ModelTiersConfigSchema.parse({ reasoning_effort: "extreme" })).toThrow();
    expect(() => ModelTiersConfigSchema.parse({ fallback_on_pin: "yes" })).toThrow();
  });

  it("the config enum and the gateway's list are the same five values", () => {
    const shape = ModelTiersConfigSchema.shape.reasoning_effort.unwrap();
    expect([...shape.options]).toEqual([...REASONING_EFFORTS]);
  });
});

describe("the env bridge", () => {
  it("writes only what is configured, and reads back what was written", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(applyModelCallEnv({}, env)).toEqual([]);
    expect(modelCallPolicyFromEnv(env)).toEqual({ fallbackOnPin: false });

    expect(applyModelCallEnv({ fallback_on_pin: true, reasoning_effort: "high" }, env)).toEqual([
      MODEL_CALL_ENV.fallbackOnPin,
      MODEL_CALL_ENV.reasoningEffort,
    ]);
    expect(modelCallPolicyFromEnv(env)).toEqual({ fallbackOnPin: true, reasoningEffort: "high" });
  });

  it("ignores a bridged effort it does not recognise instead of sending it", () => {
    expect(modelCallPolicyFromEnv({ [MODEL_CALL_ENV.reasoningEffort]: "extreme" })).toEqual({ fallbackOnPin: false });
  });

  it("applyModelEnv carries the models block's two keys to the gateway, whatever the provider", () => {
    for (const name of Object.values(MODEL_CALL_ENV)) delete process.env[name];
    const report = applyModelEnv({ provider: "google", model: "gemini-3.5-flash-lite", models: { reasoning_effort: "medium", fallback_on_pin: false } });
    expect(process.env[MODEL_CALL_ENV.reasoningEffort]).toBe("medium");
    expect(process.env[MODEL_CALL_ENV.fallbackOnPin]).toBe("false");
    expect(report.written).toEqual(expect.arrayContaining([MODEL_CALL_ENV.reasoningEffort, MODEL_CALL_ENV.fallbackOnPin]));
  });
});

// [L0-1] G4 (local-path audit 2026-09-26): a pinned `mistral:7b` under `provider: ollama` was routed by
// the NAME to api.mistral.ai, with the local placeholder bearer. Routing is by provider only.
describe("[L0-1] planAttempts routes by provider, never by a substring of the model id", () => {
  const byName = (model: string): ModelProvider | undefined =>
    model.includes("mistral") ? "mistral" : model.includes("gemini") ? "google" : model.includes("claude") ? "anthropic" : undefined;
  const base = {
    routeProviders: ["openai", "anthropic", "google", "mistral"] as ModelProvider[],
    modelForProvider: (provider: ModelProvider) => `${provider}-default`,
    inferProvider: byName,
  };

  it("under a local alias a pinned id goes to the alias's provider whatever its name contains", () => {
    for (const model of ["mistral:7b", "gemini-distill:2b", "claude-local:8b"]) {
      const plan = planAttempts({ ...base, alias: "ollama", requestModel: model, fallbackOnPin: false });
      expect(plan.attempts, model).toEqual([{ provider: "openai", model }]);
    }
  });

  it("under a local alias nothing is planned on another provider: no pin fallback, no default-chain fallback", () => {
    expect(planAttempts({ ...base, alias: "ollama", requestModel: "mistral:7b", fallbackOnPin: true }).attempts).toEqual([
      { provider: "openai", model: "mistral:7b" },
    ]);
    expect(planAttempts({ ...base, alias: "lmstudio", fallbackOnPin: false }).attempts).toEqual([
      { provider: "openai", model: "openai-default" },
    ]);
  });

  it("under a hosted alias a pin is the alias's too, and the configured chain still backs a default call", () => {
    const pinned = planAttempts({ ...base, alias: "groq", requestModel: "mistral-saba-24b", fallbackOnPin: false });
    expect(pinned.attempts).toEqual([{ provider: "openai", model: "mistral-saba-24b" }]);
    expect(planAttempts({ ...base, alias: "groq", fallbackOnPin: false }).attempts.map((a) => a.provider)).toEqual(base.routeProviders);
  });

  it("without an alias the five native providers keep today's rule", () => {
    expect(planAttempts({ ...base, alias: null, requestModel: "gemini-3.5-flash", fallbackOnPin: false }).attempts).toEqual([
      { provider: "google", model: "gemini-3.5-flash" },
    ]);
  });

  it("reads the process's alias when the caller does not pass one (the gateway passes none)", () => {
    const before = process.env[ALIAS_ENV];
    process.env[ALIAS_ENV] = "ollama";
    try {
      expect(planAttempts({ ...base, requestModel: "mistral:7b", fallbackOnPin: false }).attempts).toEqual([{ provider: "openai", model: "mistral:7b" }]);
    } finally {
      if (before === undefined) delete process.env[ALIAS_ENV];
      else process.env[ALIAS_ENV] = before;
    }
  });
});

// [L0-1] G11: nothing in the gate tells a local model from a hosted one (the audit's search, 2026-09-26),
// so the one rule lives here and is used for the label only.
describe("[L0-1] isLocalModel and the hosting label", () => {
  it("a model on a local runtime is local unless Ollama tags it as a cloud model", () => {
    expect(isLocalModel("ollama", "qwen3:4b")).toBe(true);
    expect(isLocalModel("lmstudio", "mistral-7b-instruct")).toBe(true);
    expect(isLocalModel("ollama", "nemotron-3-ultra:cloud")).toBe(false);
    expect(isLocalModel("ollama", "gpt-oss:120b-cloud")).toBe(false);
    expect(isLocalModel("groq", "llama-3.3-70b-versatile")).toBe(false);
    expect(isLocalModel("google", "gemini-3.5-flash")).toBe(false);
    expect(isLocalModel(undefined, "qwen3:4b")).toBe(false);
  });

  it("labels where the tokens are made", () => {
    expect(modelHostingLabel("ollama", "nemotron-3-ultra:cloud")).toBe("hosted via ollama");
    expect(modelHostingLabel("ollama", "qwen3:4b")).toBe("local via ollama");
    expect(modelHostingLabel("lmstudio", "local-model")).toBe("local via lmstudio");
    expect(modelHostingLabel("groq", "llama-3.3-70b-versatile")).toBe("hosted via groq");
    expect(modelHostingLabel("google", "gemini-3.5-flash")).toBe("hosted by google");
  });
});
