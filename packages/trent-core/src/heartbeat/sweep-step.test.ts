/**
 * [G3] The sweep's headroom against the one daily ledger.
 *
 * D2 computed the heartbeat's headroom from the heartbeat's OWN history, because no cross-surface
 * ledger existed: a founder who spent the cap in the REPL at noon still bought an unattended sweep
 * at midnight. These tests are about the arithmetic of one shared meter; nothing here runs a sweep
 * through a model — the port is a fake that returns a report.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { installSpendLedger, openSpendLedger, type SpendLedger } from "../governance/spend-ledger.js";
import type { SweepReport } from "../improve/sweep.js";
import { decideSweep, ledgerHeadroomCents, sweepThroughPort, type HeartbeatSweepDeps } from "./sweep-step.js";

let profileDir: string;
let spend: SpendLedger;

const AT = "2026-09-18T12:00:00.000Z";
const now = new Date(AT);

const report = (costCents: number): SweepReport =>
  ({ agents: [], skippedSpecialists: [], errors: [], costCents, budget: { limitCents: 100, exhausted: false } }) as unknown as SweepReport;

const budgetPort = (limitCents: number, spentCents: number): { limitCents: () => number; spentCents: () => number } => ({
  limitCents: () => limitCents,
  spentCents: () => spentCents,
});

const charge = (surface: string, cents: number, at = AT): void => {
  spend.append({ at, surface, run_id: `run_${surface}`, model: "m", provider: "p", cents, tokens: 10 });
};

beforeEach(() => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-sweep-spend-"));
  spend = openSpendLedger({ profileDir, now: () => now });
});

afterEach(() => {
  installSpendLedger(undefined);
  fs.rmSync(profileDir, { recursive: true, force: true });
});

describe("the sweep's headroom", () => {
  it("is the heartbeat's own ledger when no shared one is installed", () => {
    expect(ledgerHeadroomCents(budgetPort(1000, 250), now)).toBe(750);
    expect(ledgerHeadroomCents(undefined, now)).toBeUndefined();
    expect(ledgerHeadroomCents(budgetPort(0, 250), now)).toBeUndefined();
  });

  it("counts what every other surface spent today once a shared ledger is installed", () => {
    charge("repl", 700);
    charge("gateway", 120);
    charge("cron", 5000, "2026-09-17T12:00:00.000Z");
    installSpendLedger(spend);
    expect(ledgerHeadroomCents(budgetPort(1000, 0), now)).toBe(180);
  });

  it("takes the larger view, so a surface that does not write the ledger cannot buy headroom", () => {
    charge("repl", 100);
    installSpendLedger(spend);
    // The heartbeat's own history says 400; the ledger has only seen 100 of it.
    expect(ledgerHeadroomCents(budgetPort(1000, 400), now)).toBe(600);
  });

  it("refuses the sweep when the shared day leaves less than the sweep's cap", () => {
    charge("repl", 950);
    installSpendLedger(spend);
    const headroomCents = ledgerHeadroomCents(budgetPort(1000, 0), now);
    expect(decideSweep({ now, quiet: false, enabled: true, intervalHours: 24, lastSweepAt: undefined, capCents: 100, headroomCents })).toBe("budget");
    expect(decideSweep({ now, quiet: false, enabled: true, intervalHours: 24, lastSweepAt: undefined, capCents: 50, headroomCents })).toBe(null);
  });
});

describe("what a sweep charges the day", () => {
  const deps = (costCents: number): HeartbeatSweepDeps => ({ capCents: 100, runSweep: async () => report(costCents) });

  it("writes the sweep's own spend to the shared ledger, tagged heartbeat", async () => {
    installSpendLedger(spend);
    const record = await sweepThroughPort(deps(37), { at: AT, capCents: 100, trigger: "manual" });
    expect(record.costCents).toBe(37);
    const rows = spend.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ surface: "heartbeat", cents: 37, at: AT });
    expect(rows[0]?.run_id).toContain("sweep");
    expect(spend.dailyTotalCents(now)).toBe(37);
  });

  it("writes nothing for a sweep that cost nothing, and nothing at all with no ledger installed", async () => {
    installSpendLedger(spend);
    await sweepThroughPort(deps(0), { at: AT, capCents: 100, trigger: "heartbeat" });
    expect(spend.rows()).toEqual([]);

    installSpendLedger(undefined);
    const record = await sweepThroughPort(deps(12), { at: AT, capCents: 100, trigger: "heartbeat" });
    expect(record.costCents).toBe(12);
    expect(spend.rows()).toEqual([]);
  });

  it("keeps a port that throws off the ledger and reports the reason", async () => {
    installSpendLedger(spend);
    const record = await sweepThroughPort(
      { capCents: 100, runSweep: async () => { throw new Error("improve store unavailable"); } },
      { at: AT, capCents: 100, trigger: "heartbeat" },
    );
    expect(record.errors).toEqual(["improve store unavailable"]);
    expect(spend.rows()).toEqual([]);
  });
});
