/**
 * [D1] the judge runs on a different model from the executor (plan decision 6).
 *
 * A judge that IS the executor grades its own family's output with its own failure modes, and the
 * one calibration number that would catch it (TNR) is exactly the one a same-model judge inflates.
 * Decision 6 accepts the weaker form — a different Gemini model on the one key this profile has —
 * and records same-family as a limit until a second key exists. What is NOT negotiable is that the
 * two ids differ: equal models are a configuration error naming both, never a silent self-grade.
 */
import { describe, expect, it } from "vitest";

import { EXIT, isTrentError } from "../errors/index.js";
import { MODEL_PRICE_TABLE } from "../model-gateway/pricing.js";
import { DEFAULT_CONFIG } from "../config/defaults.js";
import { TrentConfigSchema } from "../config/schema.js";
import { resolveJudgeModel, strongestPricedGemini } from "./index.js";

const EXECUTOR = DEFAULT_CONFIG.model;

describe("[D1] the default judge model", () => {
  it("is the strongest priced Gemini model in the wrapper's own table, never the executor", () => {
    const strongest = strongestPricedGemini(EXECUTOR);
    expect(strongest).toBeDefined();
    expect(strongest).not.toBe(EXECUTOR);
    expect(MODEL_PRICE_TABLE[strongest!]).toBeDefined();

    const priced = Object.entries(MODEL_PRICE_TABLE).filter(([id]) => id.startsWith("gemini-"));
    const best = priced.reduce((a, b) => (b[1].outputMicroCentsPerMillion > a[1].outputMicroCentsPerMillion ? b : a));
    expect(strongest).toBe(best[0]);
  });

  it("skips the executor when the executor is itself the strongest priced Gemini", () => {
    const priced = Object.entries(MODEL_PRICE_TABLE).filter(([id]) => id.startsWith("gemini-"));
    const best = priced.reduce((a, b) => (b[1].outputMicroCentsPerMillion > a[1].outputMicroCentsPerMillion ? b : a))[0];
    const second = strongestPricedGemini(best);
    expect(second).toBeDefined();
    expect(second).not.toBe(best);
  });
});

describe("[D1] resolveJudgeModel", () => {
  it("takes the configured planner tier when it differs from the executor", () => {
    const resolved = resolveJudgeModel({ executor: EXECUTOR, planner: "gemini-2.5-pro" });
    expect(resolved.model).toBe("gemini-2.5-pro");
    expect(resolved.source).toBe("planner_tier");
  });

  it("falls back to the priced table when the planner tier is the executor", () => {
    const resolved = resolveJudgeModel({ executor: EXECUTOR, planner: EXECUTOR });
    expect(resolved.model).not.toBe(EXECUTOR);
    expect(resolved.source).toBe("priced_gemini");
  });

  it("an explicit improve.judge_model wins over both", () => {
    const resolved = resolveJudgeModel({ configured: "gemini-2.0-flash", executor: EXECUTOR, planner: "gemini-2.5-pro" });
    expect(resolved.model).toBe("gemini-2.0-flash");
    expect(resolved.source).toBe("configured");
  });

  it("refuses when the judge and the executor are the same model, naming both", () => {
    try {
      resolveJudgeModel({ configured: EXECUTOR, executor: EXECUTOR });
      expect.unreachable("a judge equal to the executor must be a configuration error");
    } catch (error) {
      expect(isTrentError(error)).toBe(true);
      expect((error as { code: number }).code).toBe(EXIT.CONFIG);
      expect((error as Error).message).toContain(EXECUTOR);
      expect((error as Error).message).toContain("improve.judge_model");
    }
  });

  it("refuses when nothing priced can differ from the executor", () => {
    expect(() => resolveJudgeModel({ executor: "gpt-5.6-terra", priced: ["gpt-5.6-terra"] })).toThrow();
  });
});

describe("[D1] the judge config block", () => {
  it("improve.judge_model is empty by default, which means resolve it at run time", () => {
    expect(TrentConfigSchema.parse({}).improve.judge_model).toBe("");
    expect(DEFAULT_CONFIG.improve.judge_model).toBe("");
  });

  it("improve.min_goldens defaults to 5: reflection waits until a seat has a suite worth reading", () => {
    expect(TrentConfigSchema.parse({}).improve.min_goldens).toBe(5);
    expect(DEFAULT_CONFIG.improve.min_goldens).toBe(5);
    expect(TrentConfigSchema.safeParse({ improve: { min_goldens: 0 } }).success).toBe(false);
  });

  it("keeps a configured judge model", () => {
    expect(TrentConfigSchema.parse({ improve: { judge_model: "gemini-2.5-pro" } }).improve.judge_model).toBe("gemini-2.5-pro");
  });
});

/**
 * [L0-3] G6: under a local provider the judge never falls back to a hosted model.
 *
 * With `provider: ollama` and no `improve.judge_model`, the resolver used to return the strongest
 * priced Gemini id, which Ollama was then asked for (01_discovery/output/trent-local-path-audit-2026-09-26.md,
 * G6). A local profile grades with a second LOCAL model or refuses, by name.
 */
describe("[L0-3] the judge under a local provider", () => {
  const refusal = "judge needs a second local model: set improve.judge_model";

  it("refuses with no improve.judge_model instead of resolving a priced Gemini id", () => {
    for (const provider of ["ollama", "lmstudio"]) {
      try {
        resolveJudgeModel({ executor: "qwen3.5:9b", provider });
        expect.unreachable(`${provider}: a local profile must not fall back to a hosted judge`);
      } catch (error) {
        expect(isTrentError(error), provider).toBe(true);
        expect((error as { code: number }).code, provider).toBe(EXIT.CONFIG);
        expect((error as Error).message, provider).toContain(refusal);
      }
    }
  });

  it("does not take the planner tier either: only improve.judge_model names the second local model", () => {
    expect(() => resolveJudgeModel({ executor: "qwen3.5:9b", planner: "qwen3.6:27b", provider: "ollama" })).toThrow(refusal);
  });

  it("takes a configured second local model", () => {
    expect(resolveJudgeModel({ configured: "qwen3.6:27b", executor: "qwen3.5:9b", provider: "ollama" })).toEqual({ model: "qwen3.6:27b", source: "configured" });
  });

  it("refuses a configured hosted model, a priced id or an Ollama cloud model, under a local provider", () => {
    const hosted = strongestPricedGemini("qwen3.5:9b")!;
    expect(() => resolveJudgeModel({ configured: hosted, executor: "qwen3.5:9b", provider: "ollama" })).toThrow(/second local model/);
    expect(() => resolveJudgeModel({ configured: "nemotron-3-ultra:cloud", executor: "qwen3.5:9b", provider: "ollama" })).toThrow(/second local model/);
  });

  it("still refuses a judge equal to the executor", () => {
    expect(() => resolveJudgeModel({ configured: "qwen3.5:9b", executor: "qwen3.5:9b", provider: "ollama" })).toThrow(/must be different models/);
  });

  it("a hosted provider keeps the priced fallback", () => {
    expect(resolveJudgeModel({ executor: EXECUTOR, provider: "google" }).source).toBe("priced_gemini");
  });
});
