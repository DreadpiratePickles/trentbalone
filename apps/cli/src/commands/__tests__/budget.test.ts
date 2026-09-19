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

import { openSpendLedger } from "@trent/core/governance/index.js";
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
  delete process.env.TRENT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

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

  it("reports a profile that has never spent as zero rather than failing", async () => {
    const result = await runCli(["budget", "status", "--json"], { overrides: { now: () => at } });
    expect(result.exitCode).toBe(EXIT.OK);
    const data = JSON.parse(result.stdout) as BudgetStatusJson;
    expect(data.spentCents).toBe(0);
    expect(data.bySurface).toEqual([]);
    expect(data.remainingCents).toBe(1000);
  });
});
