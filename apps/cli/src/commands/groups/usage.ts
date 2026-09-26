/**
 * [X3] `trent usage` — what this cost, today and over a period, from the one spend ledger.
 *
 * `trent budget status` answers "how close am I to the cap today, and which surface spent it".
 * This answers the founder's next question: what did the week or the month cost, and which seat,
 * model, provider or tool it went to. Both read the same `spend.ndjson` through the same report
 * (`@trent/core/governance/spend-report.ts`), so the two never disagree about a number.
 *
 * The command reads; it writes nothing, so `--dry-run` reports exactly what a normal run does.
 * Money is integer cents in the data and formatted only at the edge, for a human.
 */
import {
  buildSpendReport,
  openSpendLedger,
  resolveSpendGroupKey,
  resolveSpendWindow,
  SPEND_GROUP_KEYS,
  type SpendGroupKey,
  type SpendReportOptions,
  type SpendRow,
  type SpendTotals,
  type SpendWindow,
} from "@trent/core/governance/index.js";
import type { CommandSpec } from "../registry.js";
import type { CommandContext } from "../context.js";
import { formatCents } from "../../repl/budget.js";

const FULL_PERCENT = 100;
const KEY_WIDTH = 18;
/** "estimated", the longer of the two flag labels, so their counts line up. */
const FLAG_WIDTH = 9;

/**
 * [P2-10] A window's totals plus how many of its rows carry the P2-8 flags: `estimated` (the
 * provider reported no usage, so the tokens are chars/4) and `unpriced` (no price row, so the cents
 * are the app's tier stand-in). Always present in `--json`, zero included, like `cachedInputTokens`.
 */
export type UsageTotals = SpendTotals & { estimatedRows: number; unpricedRows: number };

export interface UsageData {
  /** Today on `heartbeat.active_hours.tz`: the day `today` covers and the last day of `since`. */
  date: string;
  tz: string;
  /** Which layer holds the rows, and where. */
  layer: string;
  path: string;
  by: SpendGroupKey;
  since: SpendWindow;
  caps: { dailyCapCents: number };
  /** Headroom under `budget.daily_cap` for the rest of today; zero when there is no cap. */
  remainingCents: number;
  percent: number;
  today: UsageTotals;
  period: UsageTotals;
  [key: string]: unknown;
}

/**
 * The flag counts come from the same report over the flagged rows only, so the window and the day
 * key are the report's and are not re-derived here.
 */
function flaggedTotals(rows: readonly SpendRow[], options: SpendReportOptions): { today: UsageTotals; period: UsageTotals } {
  const report = buildSpendReport(rows, options);
  const estimated = buildSpendReport(rows.filter((row) => row.estimated === true), options);
  const unpriced = buildSpendReport(rows.filter((row) => row.unpriced === true), options);
  return {
    today: { ...report.today, estimatedRows: estimated.today.rows, unpricedRows: unpriced.today.rows },
    period: { ...report.period, estimatedRows: estimated.period.rows, unpricedRows: unpriced.period.rows },
  };
}

/** One line per flag the window's rows carry; nothing when none do. */
function renderFlags(totals: UsageTotals, ctx: CommandContext): string[] {
  const lines: string[] = [];
  if (totals.estimatedRows > 0) {
    lines.push(`  ${ctx.theme.meta("estimated".padEnd(FLAG_WIDTH, " "))} ${ctx.theme.body(`${totals.estimatedRows} of ${totals.rows} charges: the provider reported no usage, so their tokens are chars/4`)}`);
  }
  if (totals.unpricedRows > 0) {
    lines.push(`  ${ctx.theme.meta("unpriced".padEnd(FLAG_WIDTH, " "))} ${ctx.theme.body(`${totals.unpricedRows} of ${totals.rows} charges: no price row for the model, so their cents are the app's tier stand-in`)}`);
  }
  return lines;
}

function renderTotals(label: string, totals: SpendTotals, ctx: CommandContext): string[] {
  // [P1-C] Prompt-cache hits are named only when there were some; the JSON always carries the total.
  const cached = totals.cachedInputTokens > 0 ? `, ${totals.cachedInputTokens} cached` : "";
  const lines = [`  ${ctx.theme.meta(label.padEnd(8, " "))} ${ctx.theme.value(formatCents(totals.cents))} ${ctx.theme.meta(`${totals.cents} cents, ${totals.tokens} tokens${cached}, ${totals.rows} charges`)}`];
  for (const group of totals.groups) {
    lines.push(`    ${ctx.theme.body(group.key.padEnd(KEY_WIDTH, " "))} ${ctx.theme.value(formatCents(group.cents))} ${ctx.theme.meta(`${group.tokens} tokens, ${group.rows} charges`)}`);
  }
  return lines;
}

export const usageSpec: CommandSpec = {
  name: "usage",
  description: "Spend from the ledger, today and over a period, by surface, seat, model, provider or tool",
  options: [
    { flags: "--since <window>", description: "A day count such as 7d or 30d, or a calendar day as YYYY-MM-DD; defaults to the month to date" },
    { flags: "--by <field>", description: `Group the totals by one of ${SPEND_GROUP_KEYS.join(", ")}; defaults to surface` },
  ],
  run(ctx, opts) {
    const configManager = ctx.config();
    const config = configManager.loadConfig();
    const tz = config.heartbeat.active_hours?.tz ?? "UTC";
    const ledger = openSpendLedger({ profileDir: configManager.getProfileDir(), tz });
    const now = (ctx.overrides.now ?? ((): Date => new Date()))();
    const window = resolveSpendWindow(opts.since === undefined ? undefined : String(opts.since), now, tz);
    const by = resolveSpendGroupKey(opts.by);
    const report = flaggedTotals(ledger.rows(), { now, tz, window, by });

    const dailyCapCents = config.budget.daily_cap;
    const data: UsageData = {
      date: window.to,
      tz,
      layer: ledger.layer,
      path: ledger.path,
      by,
      since: window,
      caps: { dailyCapCents },
      remainingCents: dailyCapCents > 0 ? dailyCapCents - report.today.cents : 0,
      percent: dailyCapCents > 0 ? Math.floor((report.today.cents * FULL_PERCENT) / dailyCapCents) : 0,
      today: report.today,
      period: report.period,
    };
    return { data };
  },
  render(data, ctx: CommandContext) {
    const d = data as unknown as UsageData;
    const over = d.remainingCents <= 0 && d.caps.dailyCapCents > 0;
    const headroom = `${formatCents(d.remainingCents)} left of budget.daily_cap ${formatCents(d.caps.dailyCapCents)} (${d.percent}% spent)`;
    const lines = [
      `  ${ctx.theme.emphasis("USAGE")} ${ctx.theme.value(d.date)} ${ctx.theme.meta(`${d.tz}, by ${d.by}`)}`,
      ...renderTotals("today", d.today, ctx),
      `  ${ctx.theme.meta("headroom")} ${over ? ctx.theme.needsApproval(headroom) : ctx.theme.body(headroom)}`,
      ...renderTotals(d.since.requested, d.period, ctx),
      ...renderFlags(d.period, ctx),
      `  ${ctx.theme.meta(`period ${d.since.from} to ${d.since.to}, ${d.since.days} days; every surface appends to ${d.path}`)}`,
    ];
    return lines;
  },
};
