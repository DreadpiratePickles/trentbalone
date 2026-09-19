/**
 * 3.7 — the budget ticker, summed from real gateway costs in integer cents.
 *
 * Thresholds come from config. No float ever touches a cents field, and the old
 * hard-coded 0.12 / 0.04 sample values are gone (see no-canned.test.ts).
 */

import { afterEach, beforeEach, describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openSpendLedger } from "@trent/core/governance/index.js";
import { createTheme, EMBER_SGR, sgrCodesIn } from "../../ui/index.js";
import { DEFAULT_CONFIG } from "@trent/core/config/index.js";
import { BudgetLedger, formatCents } from "../budget.js";
import { makeHarness, DEFAULT_EVENTS } from "./harness.js";

const plain = createTheme("none");

describe("integer-cent arithmetic", () => {
  it("formats cents at the edge only", () => {
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(7)).toBe("$0.07");
    expect(formatCents(1234)).toBe("$12.34");
  });

  it("refuses a float, because money is integer cents", () => {
    const ledger = new BudgetLedger({ capCents: 1000, thresholds: [50, 80, 100] });
    expect(() => ledger.record(0.04)).toThrow(/integer cents/i);
  });

  it("sums real costs rather than reporting a constant", () => {
    const ledger = new BudgetLedger({ capCents: 1000, thresholds: [50, 80, 100] });
    for (const cost of [17, 3, 128]) ledger.record(cost);
    expect(ledger.spentCents).toBe(148);
    expect(ledger.render(plain)).toContain("$1.48 / $10.00");
    expect(ledger.render(plain)).toContain("14%");
  });
});

describe("thresholds read from config, never from a literal", () => {
  it("warns exactly once per configured threshold as it is crossed", () => {
    const ledger = new BudgetLedger({
      capCents: DEFAULT_CONFIG.budget.daily_cap,
      thresholds: DEFAULT_CONFIG.budget.alert_thresholds,
    });
    expect(DEFAULT_CONFIG.budget.alert_thresholds).toEqual([50, 80, 100]);

    ledger.record(400);
    expect(ledger.takeCrossed()).toEqual([]);
    ledger.record(150); // 55%
    expect(ledger.takeCrossed()).toEqual([50]);
    ledger.record(10);
    expect(ledger.takeCrossed()).toEqual([]); // not re-announced
    ledger.record(500); // 106%
    expect(ledger.takeCrossed()).toEqual([80, 100]);
  });

  it("honours a different configured threshold set", () => {
    const ledger = new BudgetLedger({ capCents: 200, thresholds: [25] });
    ledger.record(60);
    expect(ledger.takeCrossed()).toEqual([25]);
  });

  it("paints the ticker ember once a threshold is live", () => {
    const colour = createTheme("truecolor");
    const ledger = new BudgetLedger({ capCents: 100, thresholds: [50] });
    ledger.record(10);
    expect(sgrCodesIn(ledger.render(colour))).not.toContain(EMBER_SGR.truecolor);
    ledger.record(60);
    expect(sgrCodesIn(ledger.render(colour))).toContain(EMBER_SGR.truecolor);
  });
});

describe("three turns through the engine", () => {
  it("produces a ticker equal to the sum of the three real costs", async () => {
    const h = makeHarness();
    await h.engine.submit("one");
    await h.engine.submit("two");
    await h.engine.submit("three");

    const perTurn = DEFAULT_EVENTS.filter((e) => e.kind === "step_end")
      .map((e) => e.step?.costCents ?? 0)
      .reduce((a, b) => a + b, 0);
    expect(perTurn).toBeGreaterThan(0);

    expect(h.engine.budget.spentCents).toBe(perTurn * 3);
    expect(h.engine.budget.render(plain)).toContain(formatCents(perTurn * 3));
  });
});

/**
 * [G3] One cap, one ledger. The REPL's ticker is seeded from the day's spend that every surface
 * writes, and the refusal is measured against that total — not against this session alone.
 */
describe("the daily cap is measured against the shared spend ledger", () => {
  let profileDir: string;
  const at = new Date("2026-09-18T12:00:00.000Z");
  const now = (): Date => at;

  beforeEach(() => {
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-repl-spend-"));
  });

  afterEach(() => {
    fs.rmSync(profileDir, { recursive: true, force: true });
  });

  it("opens with what the other surfaces already spent today", () => {
    const spend = openSpendLedger({ profileDir, now });
    spend.append({ at: at.toISOString(), surface: "gateway", run_id: "run_g", model: "m", provider: "p", cents: 640, tokens: 10 });
    spend.append({ at: "2026-09-17T12:00:00.000Z", surface: "cron", run_id: "run_y", model: "m", provider: "p", cents: 9000, tokens: 10 });

    const ledger = new BudgetLedger({ capCents: 1000, thresholds: [50, 80, 100], spend, now });
    expect(ledger.spentCents).toBe(640);
    expect(ledger.percent).toBe(64);
    // Yesterday's spend is not today's.
    expect(ledger.exceeded()).toBe(null);
  });

  it("writes every cost it records to the ledger, tagged repl, so the next surface sees it", () => {
    const spend = openSpendLedger({ profileDir, now });
    const ledger = new BudgetLedger({ capCents: 1000, thresholds: [50], spend, now, runId: "run_repl" });
    ledger.record(25, { model: "claude-sonnet-4", provider: "anthropic", tokens: 700, seat: "engineer" });
    expect(ledger.spentCents).toBe(25);
    const rows = spend.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ surface: "repl", run_id: "run_repl", model: "claude-sonnet-4", provider: "anthropic", cents: 25, tokens: 700, seat: "engineer" });
    expect(spend.dailyTotalCents(at)).toBe(25);
  });

  it("refuses at the cap on another surface's spend, not only its own", () => {
    const spend = openSpendLedger({ profileDir, now });
    const ledger = new BudgetLedger({ capCents: 500, thresholds: [50, 100], spend, now });
    ledger.record(100);
    expect(ledger.exceeded()).toBe(null);

    // The heartbeat sweeps while the REPL sits idle; the next turn must not start.
    spend.append({ at: at.toISOString(), surface: "heartbeat", run_id: "run_h", model: "m", provider: "p", cents: 400, tokens: 0 });
    expect(ledger.exceeded()).toMatchObject({ kind: "daily", capCents: 500, spentCents: 500 });
    expect(ledger.stopText(ledger.exceeded() ?? { kind: "daily", capCents: 0, spentCents: 0 })).toContain("budget.daily_cap");
    expect(ledger.takeCrossed()).toContain(100);
  });

  it("keeps the per-run cap on this session's run while the daily total is the ledger's", () => {
    const spend = openSpendLedger({ profileDir, now });
    const ledger = new BudgetLedger({ capCents: 10_000, thresholds: [50], perRunCapCents: 50, spend, now });
    ledger.beginRun();
    ledger.record(60);
    expect(ledger.exceeded()).toMatchObject({ kind: "per_run", capCents: 50, spentCents: 60 });
    ledger.beginRun();
    expect(ledger.exceeded()).toBe(null);
    expect(ledger.spentCents).toBe(60);
  });

  it("behaves exactly as before when no ledger is wired", () => {
    const ledger = new BudgetLedger({ capCents: 1000, thresholds: [50], openingCents: 40 });
    ledger.record(10);
    expect(ledger.spentCents).toBe(50);
  });
});
