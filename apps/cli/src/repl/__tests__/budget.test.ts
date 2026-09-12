/**
 * 3.7 — the budget ticker, summed from real gateway costs in integer cents.
 *
 * Thresholds come from config. No float ever touches a cents field, and the old
 * hard-coded 0.12 / 0.04 sample values are gone (see no-canned.test.ts).
 */

import { describe, it, expect } from "vitest";
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
