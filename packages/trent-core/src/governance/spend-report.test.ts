/**
 * [X3] The spend report: the ledger's rows, windowed and grouped, in integer cents. RED first:
 * every assertion is a total computed from rows this test wrote, never a string.
 */
import { describe, expect, it } from "vitest";

import { buildSpendReport, resolveSpendWindow, SPEND_GROUP_KEYS, spendDayWindow, UNATTRIBUTED } from "./spend-report.js";
import type { SpendRow } from "./spend-ledger.js";

const now = new Date("2026-09-18T12:00:00.000Z");

const row = (over: Partial<SpendRow>): SpendRow => ({
  at: "2026-09-18T09:00:00.000Z",
  surface: "repl",
  run_id: "run_1",
  model: "claude-sonnet-4",
  provider: "anthropic",
  cents: 10,
  tokens: 100,
  ...over,
});

/** Two surfaces, two seats, two providers, one tool row; one row outside a 7-day window. */
const rows: SpendRow[] = [
  row({ surface: "repl", seat: "engineer", cents: 120, tokens: 1000 }),
  row({ surface: "cron", seat: "analyst", model: "claude-haiku-4", cents: 45, tokens: 400, at: "2026-09-18T10:00:00.000Z" }),
  row({ surface: "cron", seat: "analyst", model: "gemini-2.5-flash", provider: "google", cents: 30, tokens: 900, at: "2026-09-15T10:00:00.000Z" }),
  row({ surface: "tool", tool: "sms_send", model: "sms_send", provider: "twilio", cents: 8, tokens: 0, units: 1, at: "2026-09-16T10:00:00.000Z" }),
  row({ surface: "repl", seat: "engineer", cents: 700, tokens: 5000, at: "2026-09-02T10:00:00.000Z" }),
];

describe("resolveSpendWindow", () => {
  it("defaults to the local month to date", () => {
    expect(resolveSpendWindow(undefined, now, "UTC")).toEqual({ requested: "month", from: "2026-09-01", to: "2026-09-18", days: 18 });
  });

  it("reads Nd as the last N calendar days ending today", () => {
    expect(resolveSpendWindow("7d", now, "UTC")).toEqual({ requested: "7d", from: "2026-09-12", to: "2026-09-18", days: 7 });
    expect(resolveSpendWindow("30d", now, "UTC")).toEqual({ requested: "30d", from: "2026-08-20", to: "2026-09-18", days: 30 });
  });

  it("reads a calendar day as the start of the window", () => {
    expect(resolveSpendWindow("2026-09-16", now, "UTC")).toEqual({ requested: "2026-09-16", from: "2026-09-16", to: "2026-09-18", days: 3 });
  });

  it("takes the day boundary on the zone it is given", () => {
    // 2026-09-18T12:00Z is still 2026-09-18 in Auckland, but 2026-09-19T11:00Z is the 19th there.
    expect(resolveSpendWindow("7d", new Date("2026-09-19T11:00:00.000Z"), "Pacific/Auckland").to).toBe("2026-09-19");
  });

  it("refuses a window it cannot read", () => {
    expect(() => resolveSpendWindow("yesterday", now, "UTC")).toThrow(/7d|YYYY-MM-DD/);
    expect(() => resolveSpendWindow("0d", now, "UTC")).toThrow();
  });
});

describe("spendDayWindow", () => {
  it("is the one calendar day, so today and the period are the same day", () => {
    expect(spendDayWindow("2026-09-16")).toEqual({ requested: "2026-09-16", from: "2026-09-16", to: "2026-09-16", days: 1 });
    const report = buildSpendReport(rows, { now, tz: "UTC", window: spendDayWindow("2026-09-16"), by: "surface" });
    expect(report.today).toEqual(report.period);
    expect(report.today).toMatchObject({ cents: 8, tokens: 0, rows: 1 });
  });

  it("reaches a day in the past that resolveSpendWindow cannot name alone", () => {
    // `--since 2026-09-02` is the 2nd to today; the day window is the 2nd only.
    const since = buildSpendReport(rows, { now, tz: "UTC", window: resolveSpendWindow("2026-09-02", now, "UTC"), by: "surface" });
    const day = buildSpendReport(rows, { now, tz: "UTC", window: spendDayWindow("2026-09-02"), by: "surface" });
    expect(since.period.cents).toBe(903);
    expect(day.period).toMatchObject({ cents: 700, tokens: 5000, rows: 1 });
    expect(day.today).toEqual(day.period);
  });

  it("refuses a value that is not a calendar day", () => {
    expect(() => spendDayWindow("yesterday")).toThrow(/YYYY-MM-DD/);
    expect(() => spendDayWindow("7d")).toThrow(/YYYY-MM-DD/);
  });
});

describe("buildSpendReport", () => {
  it("totals today and the period in integer cents with tokens", () => {
    const report = buildSpendReport(rows, { now, tz: "UTC", window: resolveSpendWindow("7d", now, "UTC"), by: "surface" });
    expect(report.today).toMatchObject({ cents: 165, tokens: 1400, rows: 2 });
    expect(report.period).toMatchObject({ cents: 203, tokens: 2300, rows: 4 });
    expect(Number.isInteger(report.period.cents)).toBe(true);
  });

  it("groups by every key the command offers, largest first", () => {
    const window = resolveSpendWindow("7d", now, "UTC");
    const by = (key: (typeof SPEND_GROUP_KEYS)[number]): unknown => buildSpendReport(rows, { now, tz: "UTC", window, by: key }).period.groups;
    expect(by("surface")).toEqual([
      { key: "repl", cents: 120, tokens: 1000, rows: 1 },
      { key: "cron", cents: 75, tokens: 1300, rows: 2 },
      { key: "tool", cents: 8, tokens: 0, rows: 1 },
    ]);
    expect(by("seat")).toEqual([
      { key: "engineer", cents: 120, tokens: 1000, rows: 1 },
      { key: "analyst", cents: 75, tokens: 1300, rows: 2 },
      { key: UNATTRIBUTED, cents: 8, tokens: 0, rows: 1 },
    ]);
    expect(by("provider")).toEqual([
      { key: "anthropic", cents: 165, tokens: 1400, rows: 2 },
      { key: "google", cents: 30, tokens: 900, rows: 1 },
      { key: "twilio", cents: 8, tokens: 0, rows: 1 },
    ]);
    expect(by("model")).toEqual([
      { key: "claude-sonnet-4", cents: 120, tokens: 1000, rows: 1 },
      { key: "claude-haiku-4", cents: 45, tokens: 400, rows: 1 },
      { key: "gemini-2.5-flash", cents: 30, tokens: 900, rows: 1 },
      { key: "sms_send", cents: 8, tokens: 0, rows: 1 },
    ]);
    expect(by("tool")).toEqual([
      { key: UNATTRIBUTED, cents: 195, tokens: 2300, rows: 3 },
      { key: "sms_send", cents: 8, tokens: 0, rows: 1 },
    ]);
  });

  it("widens with the window and keeps today fixed", () => {
    const report = buildSpendReport(rows, { now, tz: "UTC", window: resolveSpendWindow("30d", now, "UTC"), by: "surface" });
    expect(report.period).toMatchObject({ cents: 903, tokens: 7300, rows: 5 });
    expect(report.today).toMatchObject({ cents: 165, tokens: 1400, rows: 2 });
  });

  it("reports an empty ledger as zeros", () => {
    const report = buildSpendReport([], { now, tz: "UTC", window: resolveSpendWindow(undefined, now, "UTC"), by: "seat" });
    expect(report.today).toEqual({ cents: 0, tokens: 0, rows: 0, groups: [] });
    expect(report.period).toEqual({ cents: 0, tokens: 0, rows: 0, groups: [] });
  });

  it("skips a row whose timestamp cannot be read", () => {
    const report = buildSpendReport([row({ at: "not a date", cents: 99 }), row({ cents: 1 })], { now, tz: "UTC", window: resolveSpendWindow("7d", now, "UTC"), by: "surface" });
    expect(report.period.cents).toBe(1);
  });
});
