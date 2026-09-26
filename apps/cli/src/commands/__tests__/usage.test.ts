/**
 * [X3] `trent usage` — what the ledger says this cost, today and over a period, grouped as
 * asked. Nothing here runs a model: the rows are appended to the profile's ledger exactly as
 * the REPL, cron and a tool adapter append them.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { installSpendLedger, openSpendLedger, recordToolSpend, UNATTRIBUTED } from "@trent/core/governance/index.js";
import { EXIT } from "@trent/core/errors/index.js";
import { runCli } from "../index.js";

let home: string;
const at = new Date("2026-09-18T12:00:00.000Z");

interface Group {
  key: string;
  cents: number;
  tokens: number;
  rows: number;
}

interface Window {
  cents: number;
  tokens: number;
  cachedInputTokens: number;
  rows: number;
  /** [P2-10] Rows the P2-8 ledger flagged `estimated` (chars/4 tokens) and `unpriced` (no price row). */
  estimatedRows: number;
  unpricedRows: number;
  groups: Group[];
}

interface UsageJson {
  date: string;
  tz: string;
  layer: string;
  path: string;
  by: string;
  since: { requested: string; from: string; to: string; days: number };
  caps: { dailyCapCents: number };
  remainingCents: number;
  percent: number;
  today: Window;
  period: Window;
}

interface Charge {
  surface: string;
  seat?: string;
  model?: string;
  provider?: string;
  cents: number;
  tokens?: number;
  cachedInputTokens?: number;
  estimated?: boolean;
  unpriced?: boolean;
  at?: string;
}

function charge(c: Charge): void {
  openSpendLedger({ profileDir: home }).append({
    at: c.at ?? at.toISOString(),
    surface: c.surface,
    run_id: `run_${c.surface}`,
    ...(c.seat === undefined ? {} : { seat: c.seat }),
    model: c.model ?? "claude-sonnet-4",
    provider: c.provider ?? "anthropic",
    cents: c.cents,
    tokens: c.tokens ?? 100,
    ...(c.cachedInputTokens === undefined ? {} : { cachedInputTokens: c.cachedInputTokens }),
    ...(c.estimated === undefined ? {} : { estimated: c.estimated }),
    ...(c.unpriced === undefined ? {} : { unpriced: c.unpriced }),
  });
}

/** Two surfaces, two seats, two providers and one tool row, all today; one older repl row. */
function seedProfile(): void {
  charge({ surface: "repl", seat: "engineer", cents: 120, tokens: 1000 });
  charge({ surface: "cron", seat: "analyst", model: "claude-haiku-4", cents: 45, tokens: 400 });
  charge({ surface: "cron", seat: "analyst", model: "gemini-2.5-flash", provider: "google", cents: 30, tokens: 900 });
  recordToolSpend({ run_id: "run_tool", tool: "sms_send", provider: "twilio", cents: 8, units: 1, at: at.toISOString() }, openSpendLedger({ profileDir: home }));
  charge({ surface: "repl", seat: "engineer", cents: 700, tokens: 5000, at: "2026-09-02T10:00:00.000Z" });
}

async function usage(argv: string[]): Promise<UsageJson> {
  const result = await runCli(["usage", ...argv, "--json"], { overrides: { now: () => at } });
  expect(result.exitCode, result.stdout).toBe(EXIT.OK);
  return JSON.parse(result.stdout) as UsageJson;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-usage-cmd-"));
  process.env.TRENT_HOME = home;
});

afterEach(() => {
  installSpendLedger(undefined);
  delete process.env.TRENT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("trent usage", () => {
  it("reports today and the month by surface, with the cap and the headroom", async () => {
    seedProfile();
    const data = await usage([]);
    expect(data.date).toBe("2026-09-18");
    expect(data.by).toBe("surface");
    expect(data.since).toEqual({ requested: "month", from: "2026-09-01", to: "2026-09-18", days: 18 });
    expect(data.today).toEqual({
      cents: 203,
      tokens: 2300,
      cachedInputTokens: 0,
      rows: 4,
      estimatedRows: 0,
      unpricedRows: 0,
      groups: [
        { key: "repl", cents: 120, tokens: 1000, rows: 1 },
        { key: "cron", cents: 75, tokens: 1300, rows: 2 },
        { key: "tool", cents: 8, tokens: 0, rows: 1 },
      ],
    });
    expect(data.period).toMatchObject({ cents: 903, tokens: 7300, rows: 5 });
    expect(data.period.groups[0]).toEqual({ key: "repl", cents: 820, tokens: 6000, rows: 2 });
    expect(data.caps.dailyCapCents).toBe(1000);
    expect(data.remainingCents).toBe(797);
    expect(data.percent).toBe(20);
    expect(data.layer).toBe("file");
    expect(data.path).toBe(path.join(home, "spend.ndjson"));
  });

  it("groups by seat, model, provider and tool", async () => {
    seedProfile();
    expect((await usage(["--by", "seat"])).today.groups).toEqual([
      { key: "engineer", cents: 120, tokens: 1000, rows: 1 },
      { key: "analyst", cents: 75, tokens: 1300, rows: 2 },
      { key: UNATTRIBUTED, cents: 8, tokens: 0, rows: 1 },
    ]);
    expect((await usage(["--by", "provider"])).today.groups).toEqual([
      { key: "anthropic", cents: 165, tokens: 1400, rows: 2 },
      { key: "google", cents: 30, tokens: 900, rows: 1 },
      { key: "twilio", cents: 8, tokens: 0, rows: 1 },
    ]);
    expect((await usage(["--by", "model"])).today.groups.map((g) => g.key)).toEqual(["claude-sonnet-4", "claude-haiku-4", "gemini-2.5-flash", "sms_send"]);
    expect((await usage(["--by", "tool"])).today.groups).toEqual([
      { key: UNATTRIBUTED, cents: 195, tokens: 2300, rows: 3 },
      { key: "sms_send", cents: 8, tokens: 0, rows: 1 },
    ]);
  });

  it("windows the period with --since and leaves today alone", async () => {
    seedProfile();
    const week = await usage(["--since", "7d"]);
    expect(week.since).toEqual({ requested: "7d", from: "2026-09-12", to: "2026-09-18", days: 7 });
    expect(week.period).toMatchObject({ cents: 203, tokens: 2300, rows: 4 });
    expect(week.today.cents).toBe(203);

    const month = await usage(["--since", "30d"]);
    expect(month.period).toMatchObject({ cents: 903, rows: 5 });

    const day = await usage(["--since", "2026-09-01"]);
    expect(day.since.from).toBe("2026-09-01");
    expect(day.period.cents).toBe(903);
  });

  it("refuses a window or a grouping it cannot read", async () => {
    const since = await runCli(["usage", "--since", "yesterday", "--json"], { overrides: { now: () => at } });
    expect(since.exitCode).toBe(EXIT.CONFIG);
    expect(since.stdout).toContain("YYYY-MM-DD");
    const by = await runCli(["usage", "--by", "colour", "--json"], { overrides: { now: () => at } });
    expect(by.exitCode).toBe(EXIT.CONFIG);
    expect(by.stdout).toContain("provider");
  });

  it("reports a profile that has never spent as zeros rather than failing", async () => {
    const data = await usage([]);
    expect(data.today).toEqual({ cents: 0, tokens: 0, cachedInputTokens: 0, rows: 0, estimatedRows: 0, unpricedRows: 0, groups: [] });
    expect(data.period).toEqual({ cents: 0, tokens: 0, cachedInputTokens: 0, rows: 0, estimatedRows: 0, unpricedRows: 0, groups: [] });
    expect(data.remainingCents).toBe(1000);
  });

  it("renders the totals, every group and the cap for a human", async () => {
    seedProfile();
    const human = await runCli(["usage", "--by", "provider", "--no-color"], { overrides: { now: () => at } });
    expect(human.exitCode).toBe(EXIT.OK);
    expect(human.stdout).toContain("$2.03");
    expect(human.stdout).toContain("$9.03");
    expect(human.stdout).toContain("anthropic");
    expect(human.stdout).toContain("google");
    expect(human.stdout).toContain("twilio");
    expect(human.stdout).toContain("2300 tokens");
    expect(human.stdout).toContain("budget.daily_cap");
  });

  // [P1-C] cached prompt tokens
  it("totals cached prompt tokens in --json, and the text names them only when there are some", async () => {
    seedProfile();
    const before = await runCli(["usage", "--no-color"], { overrides: { now: () => at } });
    expect(before.stdout).not.toContain("cached");

    charge({ surface: "run", seat: "engineer", model: "gemini-3.5-flash-lite", provider: "google", cents: 9, tokens: 1_000_000, cachedInputTokens: 800_000 });
    const data = await usage([]);
    expect(data.today.cachedInputTokens).toBe(800_000);
    expect(data.period.cachedInputTokens).toBe(800_000);
    const human = await runCli(["usage", "--no-color"], { overrides: { now: () => at } });
    expect(human.stdout).toContain("800000 cached");
  });

  // [P2-10] P2-8 writes `estimated` and `unpriced` on ledger rows; the report counts them and the text names them.
  it("counts estimated and unpriced rows in --json, and the text names each, one line, only when the period has some", async () => {
    seedProfile();
    const clean = await usage([]);
    expect(clean.today).toMatchObject({ estimatedRows: 0, unpricedRows: 0 });
    expect(clean.period).toMatchObject({ estimatedRows: 0, unpricedRows: 0 });
    const before = await runCli(["usage", "--no-color"], { overrides: { now: () => at } });
    expect(before.stdout).not.toContain("estimated");
    expect(before.stdout).not.toContain("unpriced");

    charge({ surface: "run", seat: "content", model: "gemini-3.6-flash", provider: "google", cents: 1, tokens: 500, estimated: true });
    const onlyEstimated = await runCli(["usage", "--no-color"], { overrides: { now: () => at } });
    expect(onlyEstimated.stdout).toContain("1 of 6 charges");
    expect(onlyEstimated.stdout).toContain("chars/4");
    expect(onlyEstimated.stdout).not.toContain("unpriced");

    charge({ surface: "run", seat: "critic", model: "gemini-3.6-flash", provider: "google", cents: 2, tokens: 700, estimated: true, unpriced: true });
    charge({ surface: "run", seat: "ceo", model: "house-model-1", provider: "openai", cents: 4, tokens: 900, unpriced: true, at: "2026-09-03T10:00:00.000Z" });
    const data = await usage([]);
    expect(data.today).toMatchObject({ rows: 6, estimatedRows: 2, unpricedRows: 1 });
    expect(data.period).toMatchObject({ rows: 8, estimatedRows: 2, unpricedRows: 2 });
    const week = await usage(["--since", "7d"]);
    expect(week.period).toMatchObject({ rows: 6, estimatedRows: 2, unpricedRows: 1 });

    const human = await runCli(["usage", "--no-color"], { overrides: { now: () => at } });
    const lines = human.stdout.split("\n");
    const estimatedLines = lines.filter((line) => line.includes("estimated"));
    const unpricedLines = lines.filter((line) => line.includes("unpriced"));
    expect(estimatedLines).toHaveLength(1);
    expect(unpricedLines).toHaveLength(1);
    expect(estimatedLines[0]).toContain("2 of 8 charges");
    expect(estimatedLines[0]).toContain("chars/4");
    expect(unpricedLines[0]).toContain("2 of 8 charges");
    expect(unpricedLines[0]).toContain("no price row");
  });
});
