/**
 * [P2-8] The run meter prices every model call at the answering model's list price.
 *
 * Before this, a seat call was priced by `apps/web/lib/model-gateway.ts` `estimateModelCostCents`
 * at the Anthropic TIER (sonnet = $3.00 per million input), so a gemini-3.5-flash-lite seat billed
 * ~10x its $0.30 list, and every call was rounded up to a whole cent on its own. The planner, the
 * critic and the consolidator were never metered at all. These tests pin the meter offline: exact
 * micro-cents per call, one round-up per pool, a row per seat and per orchestration role, and the
 * frame charges the meter already holds are not charged a second time.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { currentSpendLedger, installSpendLedger, openSpendLedger } from "../governance/spend-ledger.js";
import {
  CONSOLIDATION_FRAME,
  closeRunScope,
  openRunScope,
  recordRunModelCall,
  recordRunSpend,
  takeOrchestrationCharge,
  type RunModelCall,
} from "./run-hooks.js";

const FLASH_LITE = "gemini-3.5-flash-lite";

/** One flash-lite call; 1,000 in / 200 out is 80,000 micro-cents (0.08 of a cent) at list. */
function call(over: Partial<RunModelCall> = {}): RunModelCall {
  return {
    seat: "ceo",
    stepId: "s1",
    model: FLASH_LITE,
    provider: "google",
    inputTokens: 1_000,
    outputTokens: 200,
    estimated: false,
    costCents: 1,
    ...over,
  };
}

function rows() {
  return currentSpendLedger()?.rows() ?? [];
}

describe("the run meter", () => {
  let profileDir: string;

  beforeEach(() => {
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-run-meter-"));
    installSpendLedger(openSpendLedger({ profileDir, now: () => new Date("2026-09-25T12:00:00.000Z") }));
  });

  afterEach(() => {
    installSpendLedger(undefined);
    fs.rmSync(profileDir, { recursive: true, force: true });
  });

  it("a flash-lite seat of 40,000 in / 4,000 out is a row of exactly 3 cents (the sonnet tier said 18)", () => {
    openRunScope([], "run_a", { companyId: "co", objective: "tagline", surface: "run" });
    // 40,000 x $0.30/1M = 1.2 cents, 4,000 x $2.50/1M = 1.0 cent: 2.2 cents, rounded up once.
    const due = recordRunModelCall("run_a", call({ inputTokens: 40_000, outputTokens: 4_000, costCents: 18 }));
    expect(due).toBe(3);
    closeRunScope([], "run_a");

    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      surface: "run",
      run_id: "run_a",
      seat: "ceo",
      model: FLASH_LITE,
      provider: "google",
      cents: 3,
      tokens: 44_000,
      inputTokens: 40_000,
      outputTokens: 4_000,
    });
    expect(rows()[0]).not.toHaveProperty("estimated");
    expect(currentSpendLedger()?.runTotalCents("run_a")).toBe(3);
  });

  it("ten sub-cent seat calls round up ONCE for the run, not once per call", () => {
    openRunScope([], "run_b", { companyId: "co", objective: "ten calls", surface: "run" });
    const seats = ["ceo", "ceo", "ceo", "ceo", "engineer", "engineer", "engineer", "content", "content", "content"];
    const due = seats.map((seat, index) => recordRunModelCall("run_b", call({ seat, stepId: `s${index}` })));
    // 10 x 0.08 = 0.8 cents: the running total is always the true running total rounded up.
    expect(due).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    closeRunScope([], "run_b");

    const bySeat = Object.fromEntries(rows().map((row) => [row.seat, row]));
    expect(Object.keys(bySeat).sort()).toEqual(["ceo", "content", "engineer"]);
    // The one cent goes to the row with the largest share (ceo: 0.32 of a cent); the others keep
    // their tokens with 0 cents, so the rows add up to the run's rounded total, never to 3.
    expect(bySeat.ceo).toMatchObject({ cents: 1, inputTokens: 4_000, outputTokens: 800, tokens: 4_800 });
    expect(bySeat.engineer).toMatchObject({ cents: 0, inputTokens: 3_000, outputTokens: 600 });
    expect(bySeat.content).toMatchObject({ cents: 0, inputTokens: 3_000, outputTokens: 600 });
    expect(currentSpendLedger()?.runTotalCents("run_b")).toBe(1);
  });

  it("the run is rounded up once, not once per pool: 0.54 of seats and 0.34 of orchestration is 1 cent", () => {
    // The first live proof's own token counts (2026-09-25, gemini-3.5-flash-lite).
    openRunScope([], "run_live", { companyId: "co", objective: "tagline", surface: "run" });
    let framed = 0;
    framed += recordRunModelCall("run_live", call({ seat: "planner", stepId: undefined, inputTokens: 3_996, outputTokens: 481 })) ?? 0;
    framed += recordRunModelCall("run_live", call({ seat: "content", stepId: "s1", inputTokens: 6_008, outputTokens: 335 })) ?? 0;
    framed += recordRunModelCall("run_live", call({ seat: "critic", stepId: undefined, inputTokens: 955, outputTokens: 82 })) ?? 0;
    framed += recordRunModelCall("run_live", call({ seat: "ceo", stepId: "s2", inputTokens: 7_067, outputTokens: 270 })) ?? 0;
    framed += recordRunModelCall("run_live", call({ seat: "consolidator", stepId: undefined, inputTokens: 600, outputTokens: 149 })) ?? 0;
    framed += takeOrchestrationCharge("run_live")?.cents ?? 0;
    closeRunScope([], "run_live");
    expect(framed).toBe(1);
    expect(currentSpendLedger()?.runTotalCents("run_live")).toBe(1);
    expect(rows().reduce((sum, row) => sum + row.tokens, 0)).toBe(19_943);
  });

  it("planner, critic and consolidator calls are rows of their own, and the consolidation frame carries their charge", () => {
    openRunScope([], "run_c", { companyId: "co", objective: "overhead", surface: "run" });
    // 0.40 + 0.085 + 0.215 = 0.70 of a cent.
    expect(recordRunModelCall("run_c", call({ seat: "planner", stepId: undefined, inputTokens: 5_000, outputTokens: 1_000 }))).toBe(0);
    expect(recordRunModelCall("run_c", call({ seat: "critic", stepId: undefined, inputTokens: 2_000, outputTokens: 100 }))).toBe(0);
    expect(recordRunModelCall("run_c", call({ seat: "consolidator", stepId: undefined, inputTokens: 3_000, outputTokens: 500 }))).toBe(0);
    expect(takeOrchestrationCharge("run_c")).toEqual({ cents: 1, tokens: 11_600 });
    // Taken once: a second frame is not charged the same spend again.
    expect(takeOrchestrationCharge("run_c")).toEqual({ cents: 0, tokens: 0 });
    closeRunScope([], "run_c");

    const bySeat = Object.fromEntries(rows().map((row) => [row.seat, row]));
    expect(bySeat.planner).toMatchObject({ cents: 1, inputTokens: 5_000, outputTokens: 1_000, model: FLASH_LITE });
    expect(bySeat.critic).toMatchObject({ cents: 0, inputTokens: 2_000, outputTokens: 100 });
    expect(bySeat.consolidator).toMatchObject({ cents: 0, inputTokens: 3_000, outputTokens: 500 });
    expect(currentSpendLedger()?.runTotalCents("run_c")).toBe(1);
  });

  it("the ledger's run total equals what the frames charged: seat carries plus the consolidation charge", () => {
    openRunScope([], "run_d", { companyId: "co", objective: "both pools", surface: "run" });
    let framed = 0;
    framed += recordRunModelCall("run_d", call({ seat: "planner", stepId: undefined, inputTokens: 9_000, outputTokens: 900 })) ?? 0;
    framed += recordRunModelCall("run_d", call({ seat: "ceo", stepId: "s1", inputTokens: 12_000, outputTokens: 1_500 })) ?? 0;
    framed += recordRunModelCall("run_d", call({ seat: "critic", stepId: undefined, inputTokens: 3_000, outputTokens: 50 })) ?? 0;
    framed += recordRunModelCall("run_d", call({ seat: "engineer", stepId: "s2", inputTokens: 8_000, outputTokens: 2_000 })) ?? 0;
    framed += takeOrchestrationCharge("run_d")?.cents ?? 0;
    closeRunScope([], "run_d");
    expect(currentSpendLedger()?.runTotalCents("run_d")).toBe(framed);
    // Seat frames: 0.735 -> 1, then 1.475 -> 2 (one more). consolidate_end: the whole run,
    // 1.475 + 0.5975 = 2.0725 -> 3, less the 2 already charged = 1. Rounded up once: 3.
    expect(framed).toBe(3);
  });

  it("a frame charge for a step the meter already holds is not charged twice; an unmetered step still is", () => {
    openRunScope([], "run_e", { companyId: "co", objective: "frames", surface: "run" });
    recordRunModelCall("run_e", call({ stepId: "s1", inputTokens: 40_000, outputTokens: 4_000 }));
    recordRunModelCall("run_e", call({ seat: "planner", stepId: undefined }));
    recordRunSpend("run_e", { stepId: "s1", seat: "ceo", model: FLASH_LITE, provider: "google", cents: 3, tokens: 44_000 });
    recordRunSpend("run_e", { stepId: CONSOLIDATION_FRAME, model: "unattributed", provider: "google", cents: 1, tokens: 1_200 });
    recordRunSpend("run_e", { stepId: "s9", seat: "analyst", model: "claude-haiku-4", provider: "anthropic", cents: 5, tokens: 300 });
    closeRunScope([], "run_e");

    const charged = rows().map((row) => [row.seat, row.model, row.cents]);
    expect(charged).toContainEqual(["ceo", FLASH_LITE, 3]);
    expect(charged).toContainEqual(["analyst", "claude-haiku-4", 5]);
    expect(rows().filter((row) => row.seat === "ceo")).toHaveLength(1);
    expect(rows().some((row) => row.model === "unattributed")).toBe(false);
    // The metered rows are the run's exact 2.28 cents rounded up ONCE (ceo 3, planner 0 with its
    // tokens), plus the analyst's 5 as its frame charged them.
    expect(rows().find((row) => row.seat === "planner")).toMatchObject({ cents: 0, inputTokens: 1_000 });
    expect(currentSpendLedger()?.runTotalCents("run_e")).toBe(8);
  });

  it("a call whose tokens the provider did not report is marked estimated on its row", () => {
    openRunScope([], "run_f", { companyId: "co", objective: "estimate", surface: "run" });
    recordRunModelCall("run_f", call({ estimated: true }));
    recordRunModelCall("run_f", call({ seat: "engineer", stepId: "s2" }));
    closeRunScope([], "run_f");
    expect(rows().find((row) => row.seat === "ceo")).toMatchObject({ estimated: true });
    expect(rows().find((row) => row.seat === "engineer")).not.toHaveProperty("estimated");
  });

  it("a model nothing prices keeps the gateway's own per-call cents and says it is unpriced", () => {
    openRunScope([], "run_g", { companyId: "co", objective: "unpriced", surface: "run" });
    expect(recordRunModelCall("run_g", call({ model: "mystery-model-1", provider: "openai", costCents: 4 }))).toBe(4);
    closeRunScope([], "run_g");
    expect(rows()[0]).toMatchObject({ model: "mystery-model-1", cents: 4, unpriced: true });
  });

  it("cached prompt tokens reach the row and are priced at the cached rate", () => {
    openRunScope([], "run_h", { companyId: "co", objective: "cache", surface: "run" });
    // 30,000 x 30 + 10,000 x 3 + 4,000 x 250 = 1,930,000 micro-cents -> 2 cents (uncached would be 3).
    expect(recordRunModelCall("run_h", call({ inputTokens: 40_000, outputTokens: 4_000, cachedInputTokens: 10_000 }))).toBe(2);
    closeRunScope([], "run_h");
    expect(rows()[0]).toMatchObject({ cents: 2, cachedInputTokens: 10_000, inputTokens: 40_000 });
  });

  it("a call for a run nobody opened is not attributed anywhere", () => {
    expect(recordRunModelCall("run_never", call())).toBeUndefined();
    expect(recordRunModelCall(undefined, call())).toBeUndefined();
    expect(takeOrchestrationCharge("run_never")).toBeUndefined();
    expect(rows()).toEqual([]);
  });
});
