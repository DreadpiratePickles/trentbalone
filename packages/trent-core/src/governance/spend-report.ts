/**
 * [X3] The spend report: the ledger's rows, windowed on the local day and grouped by the field a
 * founder asks about. `trent usage` and `trent budget status` read through this so "what did
 * this cost" has one answer regardless of which command asked it.
 *
 * The window is calendar days on the profile's zone, the same day key the ledger caps against:
 * `Nd` is today and the N-1 days before it, a date is that day to today, and the default is the
 * local month to date. Money is INTEGER CENTS throughout; every total is a sum of the integer
 * cents the ledger already holds, never a float.
 */
import { EXIT, TrentError } from "../errors/index.js";
import { localDayKey } from "../heartbeat/quiet-hours.js";
import type { SpendRow } from "./spend-ledger.js";

/** The fields a report can be grouped on. Each is a column of `SpendRow`. */
export const SPEND_GROUP_KEYS = ["surface", "seat", "model", "provider", "tool"] as const;
export type SpendGroupKey = (typeof SPEND_GROUP_KEYS)[number];

/** The group a row lands in when it carries no value for the key: a model charge has no tool, a tool charge may have no seat. */
export const UNATTRIBUTED = "unattributed";

/** What `--since` may say. `month` is the value the default window reports as requested. */
export const SPEND_WINDOW_MONTH = "month";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAYS = /^([1-9]\d*)d$/;
const MS_PER_DAY = 86_400_000;
const WINDOW_SHAPE = "--since must be a day count such as 7d or 30d, or a calendar day as YYYY-MM-DD";

export interface SpendWindow {
  /** What was asked for, as given; `month` when nothing was. */
  readonly requested: string;
  /** First day in the window, inclusive, as YYYY-MM-DD on the report's zone. */
  readonly from: string;
  /** Today on the report's zone; the window never reaches past it. */
  readonly to: string;
  /** Calendar days the window covers. */
  readonly days: number;
}

export interface SpendGroup {
  readonly key: string;
  readonly cents: number;
  readonly tokens: number;
  readonly rows: number;
}

export interface SpendTotals {
  readonly cents: number;
  readonly tokens: number;
  readonly rows: number;
  /** Largest spender first, then by name; a group that spent nothing is not listed. */
  readonly groups: SpendGroup[];
}

export interface SpendReport {
  readonly today: SpendTotals;
  readonly period: SpendTotals;
}

export interface SpendReportOptions {
  readonly now: Date;
  readonly tz: string;
  readonly window: SpendWindow;
  readonly by: SpendGroupKey;
}

function dayKeyToUtc(dayKey: string): number {
  const [year, month, day] = dayKey.split("-").map(Number) as [number, number, number];
  return Date.UTC(year, month - 1, day);
}

function utcToDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((dayKeyToUtc(to) - dayKeyToUtc(from)) / MS_PER_DAY) + 1;
}

/** The window `--since` names, on the zone's calendar. Throws a config error naming the value when it cannot be read. */
export function resolveSpendWindow(since: string | undefined, now: Date, tz: string): SpendWindow {
  const to = localDayKey(now, tz);
  if (since === undefined) {
    const from = `${to.slice(0, 8)}01`;
    return { requested: SPEND_WINDOW_MONTH, from, to, days: daysBetween(from, to) };
  }
  const count = DAYS.exec(since);
  if (count !== null) {
    const days = Number(count[1]);
    const from = utcToDayKey(dayKeyToUtc(to) - (days - 1) * MS_PER_DAY);
    return { requested: since, from, to, days };
  }
  if (DAY.test(since) && since <= to) {
    return { requested: since, from: since, to, days: daysBetween(since, to) };
  }
  throw new TrentError({ code: EXIT.CONFIG, operation: "usage.since", message: WINDOW_SHAPE, target: since });
}

/** The grouping `--by` names, or a config error listing what it may be. */
export function resolveSpendGroupKey(by: unknown): SpendGroupKey {
  if (by === undefined) return "surface";
  const value = String(by);
  if ((SPEND_GROUP_KEYS as readonly string[]).includes(value)) return value as SpendGroupKey;
  throw new TrentError({ code: EXIT.CONFIG, operation: "usage.by", message: `--by must be one of ${SPEND_GROUP_KEYS.join(", ")}`, target: value });
}

function groupOf(row: SpendRow, by: SpendGroupKey): string {
  const value = row[by];
  return typeof value === "string" && value !== "" ? value : UNATTRIBUTED;
}

function totals(rows: readonly SpendRow[], by: SpendGroupKey): SpendTotals {
  let cents = 0;
  let tokens = 0;
  const groups = new Map<string, { cents: number; tokens: number; rows: number }>();
  for (const row of rows) {
    const rowCents = Math.trunc(row.cents);
    const rowTokens = Math.trunc(row.tokens);
    cents += rowCents;
    tokens += rowTokens;
    const key = groupOf(row, by);
    const group = groups.get(key) ?? { cents: 0, tokens: 0, rows: 0 };
    group.cents += rowCents;
    group.tokens += rowTokens;
    group.rows += 1;
    groups.set(key, group);
  }
  const sorted = [...groups.entries()]
    .map(([key, group]) => ({ key, ...group }))
    .sort((a, b) => b.cents - a.cents || a.key.localeCompare(b.key));
  return { cents, tokens, rows: rows.length, groups: sorted };
}

/** Today's and the window's totals over `rows`, each grouped by `by`. A row whose timestamp cannot be read is skipped. */
export function buildSpendReport(rows: readonly SpendRow[], options: SpendReportOptions): SpendReport {
  const { tz, window, by } = options;
  const dated: { key: string; row: SpendRow }[] = [];
  for (const row of rows) {
    const at = new Date(row.at);
    if (Number.isNaN(at.getTime())) continue;
    dated.push({ key: localDayKey(at, tz), row });
  }
  const today = dated.filter((entry) => entry.key === window.to).map((entry) => entry.row);
  const period = dated.filter((entry) => entry.key >= window.from && entry.key <= window.to).map((entry) => entry.row);
  return { today: totals(today, by), period: totals(period, by) };
}
