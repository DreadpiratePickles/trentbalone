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
  modelCallPolicyFromEnv,
} from "./call-policy.js";

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
