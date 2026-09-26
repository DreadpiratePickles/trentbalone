/**
 * [S1] The real solo meter: every model call is metered through the run scope the fleet uses
 * (`orchestrator/run-hooks.ts`), so a solo run's spend lands on the one daily ledger under seat
 * `trent` when the run closes, and the budget caps stop the run before another call is bought.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installSpendLedger, openSpendLedger } from "../governance/spend-ledger.js";
import { createRunLedgerMeter } from "./meter.js";
import type { SoloModelCall } from "./types.js";

const temps: string[] = [];
afterEach(() => {
  installSpendLedger(undefined);
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function ledger() {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-solo-meter-"));
  temps.push(profileDir);
  const opened = openSpendLedger({ profileDir, now: () => new Date("2026-09-26T09:00:00.000Z") });
  installSpendLedger(opened);
  return opened;
}

const call = (overrides: Partial<SoloModelCall> = {}): SoloModelCall => ({
  seat: "trent",
  stepId: "solo_1-trent",
  model: "an-unpriced-test-model",
  provider: "google",
  inputTokens: 100,
  outputTokens: 20,
  cachedInputTokens: 0,
  estimated: false,
  costCents: 1,
  ...overrides,
});

describe("[S1] createRunLedgerMeter", () => {
  it("prices each call and writes the run's spend to the day's ledger under seat trent when the run closes", () => {
    const book = ledger();
    const meter = createRunLedgerMeter({ surface: "repl", companyId: "co_1" });
    meter.open?.("solo_1", "Read a.md");
    expect(meter.record("solo_1", call())).toBe(1);
    expect(meter.record("solo_1", call())).toBe(1);
    expect(book.rows()).toEqual([]);
    meter.close?.("solo_1");
    const rows = book.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ surface: "repl", run_id: "solo_1", seat: "trent", model: "an-unpriced-test-model", provider: "google", cents: 2, tokens: 240, inputTokens: 200, outputTokens: 40, unpriced: true });
  });

  it("says stop once the run reaches the per-run cap, and not before", () => {
    ledger();
    const meter = createRunLedgerMeter({ surface: "run", perRunCapCents: 2 });
    meter.open?.("solo_2", "x");
    meter.record("solo_2", call());
    expect(meter.stopReason?.("solo_2")).toBeUndefined();
    meter.record("solo_2", call());
    expect(meter.stopReason?.("solo_2")).toBe("this run has spent 2 cents of its 2-cent cap (budget.per_run_cap)");
    meter.close?.("solo_2");
  });

  it("counts the day's ledger and the run in flight against the daily cap", () => {
    const book = ledger();
    book.append({ surface: "cron", run_id: "earlier", model: "m", provider: "google", cents: 9, tokens: 10 });
    const meter = createRunLedgerMeter({ surface: "repl", dailyCapCents: 10, ledger: book, now: () => new Date("2026-09-26T10:00:00.000Z") });
    meter.open?.("solo_3", "x");
    expect(meter.stopReason?.("solo_3")).toBeUndefined();
    meter.record("solo_3", call());
    expect(meter.stopReason?.("solo_3")).toBe("today's spend is 10 cents of the 10-cent daily cap (budget.daily_cap)");
    meter.close?.("solo_3");
  });
});
