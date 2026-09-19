/**
 * [D0] improvement gates — the config block the gates read.
 *
 * The keys exist, the defaults are the ones the gates document, and `sweep_cap_cents` is the
 * per-run cap (plan decision 8): a sweep may never be allowed to outspend one run by accident.
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "./defaults.js";
import { TrentConfigSchema } from "./schema.js";

describe("[D0] improve config block", () => {
  it("parses with the documented defaults when nothing is configured", () => {
    const parsed = TrentConfigSchema.parse({});
    expect(parsed.improve.holdout_ratio).toBe(0.3);
    expect(parsed.improve.pass_k).toBe(3);
    expect(parsed.improve.judge_min_tpr).toBe(0.8);
    expect(parsed.improve.judge_min_tnr).toBe(0.8);
    expect(parsed.improve.frozen_paths).toEqual([]);
  });

  it("decision 8: sweep_cap_cents defaults to budget.per_run_cap, in integer cents", () => {
    expect(DEFAULT_CONFIG.improve.sweep_cap_cents).toBe(DEFAULT_CONFIG.budget.per_run_cap);
    expect(Number.isInteger(DEFAULT_CONFIG.improve.sweep_cap_cents)).toBe(true);
  });

  it("rejects a holdout ratio outside (0,1) and a pass_k below 1", () => {
    expect(TrentConfigSchema.safeParse({ improve: { holdout_ratio: 1.5 } }).success).toBe(false);
    expect(TrentConfigSchema.safeParse({ improve: { holdout_ratio: 0 } }).success).toBe(false);
    expect(TrentConfigSchema.safeParse({ improve: { pass_k: 0 } }).success).toBe(false);
    expect(TrentConfigSchema.safeParse({ improve: { judge_min_tnr: 1.2 } }).success).toBe(false);
  });

  it("keeps a configured override", () => {
    const parsed = TrentConfigSchema.parse({ improve: { pass_k: 5, sweep_cap_cents: 40, frozen_paths: ["/srv/goldens"] } });
    expect(parsed.improve.pass_k).toBe(5);
    expect(parsed.improve.sweep_cap_cents).toBe(40);
    expect(parsed.improve.frozen_paths).toEqual(["/srv/goldens"]);
  });
});
