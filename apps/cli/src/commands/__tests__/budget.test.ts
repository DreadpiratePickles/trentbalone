/**
 * [G3] `trent budget status` — the day's spend, as every surface wrote it, against the caps that
 * govern it. Nothing here runs a model or a sweep: the rows are appended to the profile's ledger
 * directly, which is exactly what the REPL, `trent run`, the gateway, cron and the heartbeat do.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { installSpendLedger, openSpendLedger } from "@trent/core/governance/index.js";
import { closeRunScope, openRunScope, recordRunSpend } from "@trent/core/orchestrator/run-hooks.js";
import { EXIT } from "@trent/core/errors/index.js";
import { runCli } from "../index.js";

let home: string;
const at = new Date("2026-09-18T12:00:00.000Z");

interface BudgetStatusJson {
  date: string;
  layer: string;
  path: string;
  caps: { dailyCapCents: number; perRunCapCents: number; sweepCapCents: number };
  spentCents: number;
  remainingCents: number;
  percent: number;
  bySurface: { surface: string; cents: number }[];
}

function charge(surface: string, cents: number, when = at.toISOString()): void {
  openSpendLedger({ profileDir: home }).append({ at: when, surface, run_id: `run_${surface}`, model: "claude-sonnet-4", provider: "anthropic", cents, tokens: 100 });
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-budget-cmd-"));
  process.env.TRENT_HOME = home;
});

afterEach(() => {
  installSpendLedger(undefined);
  delete process.env.TRENT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

/**
 * [G3.1] One real run on a surface, as the headless runtime drives it: the run's meter is opened
 * with the surface the runtime named, the seats' billed steps are charged to it, and the run's end
 * writes them to the day's ledger. Nothing is appended by hand here.
 */
function runOnSurface(surface: string, runId: string, charges: readonly { seat: string; model: string; cents: number }[]): void {
  installSpendLedger(openSpendLedger({ profileDir: home, now: () => at }));
  openRunScope([], runId, { companyId: "cmp_1", objective: `work for ${surface}`, surface });
  for (const charge of charges) recordRunSpend(runId, { model: charge.model, provider: "anthropic", cents: charge.cents, tokens: 400, seat: charge.seat });
  closeRunScope([], runId);
}

describe("trent budget status", () => {
  it("reports today's spend by surface against the caps", async () => {
    charge("repl", 120);
    charge("gateway", 45);
    charge("heartbeat", 35);
    charge("cron", 900, "2026-09-17T12:00:00.000Z");

    const result = await runCli(["budget", "status", "--json"], { overrides: { now: () => at } });
    expect(result.exitCode).toBe(EXIT.OK);
    const data = JSON.parse(result.stdout) as BudgetStatusJson;
    expect(data.date).toBe("2026-09-18");
    expect(data.spentCents).toBe(200);
    expect(data.caps).toMatchObject({ dailyCapCents: 1000, perRunCapCents: 100, sweepCapCents: 100 });
    expect(data.remainingCents).toBe(800);
    expect(data.percent).toBe(20);
    expect(data.bySurface).toEqual([
      { surface: "repl", cents: 120 },
      { surface: "gateway", cents: 45 },
      { surface: "heartbeat", cents: 35 },
    ]);
    // Which layer holds the rows is part of the answer, not a detail.
    expect(data.layer).toBe("file");
    expect(data.path).toBe(path.join(home, "spend.ndjson"));
  });

  it("renders every surface, the caps and the remainder for a human", async () => {
    charge("repl", 250);
    charge("run", 50);
    const human = await runCli(["budget", "status", "--no-color"], { overrides: { now: () => at } });
    expect(human.exitCode).toBe(EXIT.OK);
    expect(human.stdout).toContain("repl");
    expect(human.stdout).toContain("run");
    expect(human.stdout).toContain("$3.00");
    expect(human.stdout).toContain("$10.00");
    expect(human.stdout).toContain("budget.daily_cap");
  });

  it("reads a day the founder names instead of today", async () => {
    charge("cron", 700, "2026-09-17T23:00:00.000Z");
    const result = await runCli(["budget", "status", "--date", "2026-09-17", "--json"], { overrides: { now: () => at } });
    const data = JSON.parse(result.stdout) as BudgetStatusJson;
    expect(data.date).toBe("2026-09-17");
    expect(data.spentCents).toBe(700);
  });

  it("refuses a date that is not a day", async () => {
    const result = await runCli(["budget", "status", "--date", "yesterday", "--json"], { overrides: { now: () => at } });
    expect(result.exitCode).toBe(EXIT.CONFIG);
    expect(result.stdout).toContain("YYYY-MM-DD");
  });

  it("shows both surfaces after a profile has run through two of them", async () => {
    // [G3.1] The point of the ledger: a founder who ran one thing in the REPL and let cron run
    // another sees one day's total and both spenders, not two meters that each know only themselves.
    runOnSurface("repl", "run_repl", [{ seat: "engineer", model: "claude-sonnet-4", cents: 60 }]);
    runOnSurface("cron", "run_cron", [
      { seat: "analyst", model: "claude-haiku-4", cents: 11 },
      { seat: "analyst", model: "claude-haiku-4", cents: 4 },
    ]);

    const result = await runCli(["budget", "status", "--json"], { overrides: { now: () => at } });
    expect(result.exitCode).toBe(EXIT.OK);
    const data = JSON.parse(result.stdout) as BudgetStatusJson;
    expect(data.bySurface).toEqual([
      { surface: "repl", cents: 60 },
      { surface: "cron", cents: 15 },
    ]);
    expect(data.spentCents).toBe(75);
    expect(data.remainingCents).toBe(925);
  });

  it("reports a profile that has never spent as zero rather than failing", async () => {
    const result = await runCli(["budget", "status", "--json"], { overrides: { now: () => at } });
    expect(result.exitCode).toBe(EXIT.OK);
    const data = JSON.parse(result.stdout) as BudgetStatusJson;
    expect(data.spentCents).toBe(0);
    expect(data.bySurface).toEqual([]);
    expect(data.remainingCents).toBe(1000);
  });

  /**
   * [G3/X3] `budget status` and `usage` read one ledger through one report, so they never disagree
   * about a number. One ledger, two days, several surfaces, and one row whose surface is the empty
   * string (a surface the ledger accepts and the report files as `unattributed`): the day's total
   * and every per-surface figure `budget status --date <day>` prints must be, cent for cent, what
   * `usage --since <day> --by surface` prints for that day as today.
   */
  it("agrees with trent usage, cent for cent, on the total and every surface of a day", async () => {
    const yesterday = "2026-09-17";
    const today = "2026-09-18";
    charge("repl", 120);
    charge("gateway", 45);
    charge("tool", 8);
    charge("", 3);
    charge("cron", 900, `${yesterday}T12:00:00.000Z`);
    charge("repl", 60, `${yesterday}T23:30:00.000Z`);
    charge("", 5, `${yesterday}T01:00:00.000Z`);

    for (const day of [today, yesterday]) {
      // `usage` windows to today, so the day under test is made today for it; `budget` names the day.
      const usageNow = new Date(`${day}T12:00:00.000Z`);
      const usage = await runCli(["usage", "--since", day, "--by", "surface", "--json"], { overrides: { now: () => usageNow } });
      expect(usage.exitCode, usage.stdout).toBe(EXIT.OK);
      const report = JSON.parse(usage.stdout) as { today: { cents: number; groups: { key: string; cents: number }[] } };

      const budget = await runCli(["budget", "status", "--date", day, "--json"], { overrides: { now: () => at } });
      expect(budget.exitCode, budget.stdout).toBe(EXIT.OK);
      const status = JSON.parse(budget.stdout) as BudgetStatusJson;

      expect(status.date).toBe(day);
      expect(status.spentCents).toBe(report.today.cents);
      expect(status.bySurface).toEqual(report.today.groups.map((group) => ({ surface: group.key, cents: group.cents })));
      expect(status.bySurface.reduce((sum, row) => sum + row.cents, 0)).toBe(status.spentCents);
    }
  });
});
