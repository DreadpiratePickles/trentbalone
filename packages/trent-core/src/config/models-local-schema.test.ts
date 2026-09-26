/**
 * [L0-2] RED: the `models.local` block (docs/configuration.md, "Local models"). Four budgets for a
 * model on the operator's own machine; each absent key keeps the gateway's default
 * (`model-gateway/local-runtime.ts` `LOCAL_MODEL_DEFAULTS`, `DEFAULT_MAX_IN_FLIGHT`), and an unknown
 * key is a config error, not a setting that does nothing.
 */
import { describe, expect, it } from "vitest";

import { applyLocalModelEnv, LOCAL_MODEL_ENV } from "../model-gateway/local-runtime.js";
import { TrentConfigSchema } from "./schema.js";

const BASE = { version: 3, profile: "local", provider: "ollama", model: "qwen3.5:9b" };

describe("models.local", () => {
  it("accepts the four keys as positive whole numbers", () => {
    const parsed = TrentConfigSchema.parse({ ...BASE, models: { local: { ttft_seconds: 600, idle_seconds: 90, context_tokens: 65_536, max_in_flight: 2 } } });
    expect(parsed.models?.local).toEqual({ ttft_seconds: 600, idle_seconds: 90, context_tokens: 65_536, max_in_flight: 2 });
  });

  it("refuses zero, fractions and unknown keys", () => {
    expect(TrentConfigSchema.safeParse({ ...BASE, models: { local: { ttft_seconds: 0 } } }).success).toBe(false);
    expect(TrentConfigSchema.safeParse({ ...BASE, models: { local: { max_in_flight: 1.5 } } }).success).toBe(false);
    expect(TrentConfigSchema.safeParse({ ...BASE, models: { local: { num_ctx: 4096 } } }).success).toBe(false);
  });

  it("is optional, and a parsed block feeds the gateway's env bridge unchanged", () => {
    expect(TrentConfigSchema.parse(BASE).models?.local).toBeUndefined();
    const parsed = TrentConfigSchema.parse({ ...BASE, models: { local: { ttft_seconds: 900 } } });
    const env: NodeJS.ProcessEnv = {};
    expect(applyLocalModelEnv(parsed.models?.local, env)).toEqual([LOCAL_MODEL_ENV.ttftSeconds]);
    expect(env[LOCAL_MODEL_ENV.ttftSeconds]).toBe("900");
  });
});
