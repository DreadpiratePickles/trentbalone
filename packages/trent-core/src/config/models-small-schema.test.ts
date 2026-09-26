/**
 * [L1] The `models` keys small local models need (docs/configuration.md, "Local models" and
 * "Hosted escalation"): three more in `models.local`, and `models.escalate`, unset by default. Each is
 * validated at load, so a misspelt value is a config error, not a setting that does nothing.
 */
import { describe, expect, it } from "vitest";

import { applyLocalModelEnv, LOCAL_MODEL_ENV } from "../model-gateway/local-runtime.js";
import { TrentConfigSchema } from "./schema.js";

const BASE = { version: 3, profile: "local", provider: "ollama", model: "qwen3.5:9b" };

describe("[L1] models.local, small-model keys", () => {
  it("accepts reasoning_effort, constrained_output (true, false or all) and job_timeout_seconds", () => {
    for (const constrained of [true, false, "all"] as const) {
      const parsed = TrentConfigSchema.parse({ ...BASE, models: { local: { reasoning_effort: "none", constrained_output: constrained, job_timeout_seconds: 3600 } } });
      expect(parsed.models?.local).toEqual({ reasoning_effort: "none", constrained_output: constrained, job_timeout_seconds: 3600 });
    }
  });

  it("refuses an unknown effort, an unknown mode and a non-positive timeout", () => {
    expect(TrentConfigSchema.safeParse({ ...BASE, models: { local: { reasoning_effort: "turbo" } } }).success).toBe(false);
    expect(TrentConfigSchema.safeParse({ ...BASE, models: { local: { constrained_output: "hosted" } } }).success).toBe(false);
    expect(TrentConfigSchema.safeParse({ ...BASE, models: { local: { job_timeout_seconds: 0 } } }).success).toBe(false);
  });

  it("a parsed block feeds the gateway's bridge", () => {
    const parsed = TrentConfigSchema.parse({ ...BASE, models: { local: { reasoning_effort: "low", constrained_output: false } } });
    const env: NodeJS.ProcessEnv = {};
    expect(applyLocalModelEnv(parsed.models?.local, env)).toEqual([LOCAL_MODEL_ENV.reasoningEffort, LOCAL_MODEL_ENV.constrainedOutput]);
  });
});

describe("[L1] models.escalate", () => {
  it("is unset by default", () => {
    expect(TrentConfigSchema.parse(BASE).models?.escalate).toBeUndefined();
  });

  it("names a hosted model and the roles that may use it", () => {
    const parsed = TrentConfigSchema.parse({ ...BASE, models: { escalate: { provider: "google", model: "gemini-3.6-pro", on: ["planner", "critic", "step_failed"] } } });
    expect(parsed.models?.escalate).toEqual({ provider: "google", model: "gemini-3.6-pro", on: ["planner", "critic", "step_failed"] });
  });

  it("refuses an unknown role, an empty role list and an unknown provider", () => {
    expect(TrentConfigSchema.safeParse({ ...BASE, models: { escalate: { model: "gemini-3.6-pro", on: ["seat"] } } }).success).toBe(false);
    expect(TrentConfigSchema.safeParse({ ...BASE, models: { escalate: { model: "gemini-3.6-pro", on: [] } } }).success).toBe(false);
    expect(TrentConfigSchema.safeParse({ ...BASE, models: { escalate: { provider: "skynet", on: ["planner"] } } }).success).toBe(false);
  });
});
