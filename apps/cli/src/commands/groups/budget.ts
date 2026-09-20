/**
 * [G3] `trent budget status` — the day's spend, by surface, against the caps that govern it.
 *
 * One ledger, one cap. Every surface appends its charges to the profile's `spend.ndjson`
 * (`@trent/core/governance/spend-ledger.ts`), so this is the only place a founder has to look to
 * answer "what has this cost me today, and who spent it". The caps are read from config and named
 * by their keys, because the next thing anyone asks is which key to raise.
 *
 * The day's total and its surfaces come from the spend report
 * (`@trent/core/governance/spend-report.ts`), windowed to the one day, which is what `trent usage`
 * reads through as well: one reader, so the two commands never disagree about a number.
 *
 * The command reads; it writes nothing, so `--dry-run` reports exactly what a normal run does.
 */
import { buildSpendReport, openSpendLedger, spendDayWindow } from "@trent/core/governance/index.js";
import { EXIT, TrentError } from "@trent/core/errors/index.js";
import type { CommandSpec } from "../registry.js";
import type { CommandContext } from "../context.js";
import { formatCents } from "../../repl/budget.js";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const FULL_PERCENT = 100;

export interface BudgetSurfaceSpend {
  surface: string;
  cents: number;
}

export interface BudgetStatusData {
  /** The local day, on `heartbeat.active_hours.tz`, that these totals cover. */
  date: string;
  tz: string;
  /** Which layer holds the rows, and where. */
  layer: string;
  path: string;
  caps: { dailyCapCents: number; perRunCapCents: number; sweepCapCents: number };
  spentCents: number;
  remainingCents: number;
  percent: number;
  /** Largest spender first; a surface that spent nothing today is not listed. */
  bySurface: BudgetSurfaceSpend[];
  [key: string]: unknown;
}

function dayOf(raw: unknown, now: Date, tz: string, ledgerDayKey: (date: Date | string) => string): string {
  if (raw === undefined) return ledgerDayKey(now);
  const value = String(raw);
  if (!DAY.test(value)) {
    throw new TrentError({
      code: EXIT.CONFIG,
      operation: "budget.status",
      message: "--date must be a calendar day as YYYY-MM-DD",
      target: value,
    });
  }
  return value;
}

export const budgetSpec: CommandSpec = {
  name: "budget",
  description: "The day's model spend across every surface, against the configured caps",
  subcommands: [
    {
      name: "status",
      description: "Show today's spend by surface and the caps it is measured against",
      options: [{ flags: "--date <day>", description: "A calendar day as YYYY-MM-DD; defaults to today on the heartbeat's timezone" }],
      run(ctx, opts) {
        const configManager = ctx.config();
        const config = configManager.loadConfig();
        const tz = config.heartbeat.active_hours?.tz ?? "UTC";
        const ledger = openSpendLedger({ profileDir: configManager.getProfileDir(), tz });
        const now = (ctx.overrides.now ?? ((): Date => new Date()))();
        const date = dayOf(opts.date, now, tz, (value) => ledger.dayKeyOf(value));

        const day = buildSpendReport(ledger.rows(), { now, tz, window: spendDayWindow(date), by: "surface" }).today;
        const spentCents = day.cents;
        const dailyCapCents = config.budget.daily_cap;
        const bySurface = day.groups.map((group) => ({ surface: group.key, cents: group.cents }));
        const data: BudgetStatusData = {
          date,
          tz,
          layer: ledger.layer,
          path: ledger.path,
          caps: { dailyCapCents, perRunCapCents: config.budget.per_run_cap, sweepCapCents: config.improve.sweep_cap_cents },
          spentCents,
          remainingCents: dailyCapCents > 0 ? dailyCapCents - spentCents : 0,
          percent: dailyCapCents > 0 ? Math.floor((spentCents * FULL_PERCENT) / dailyCapCents) : 0,
          bySurface,
        };
        return { data };
      },
      render(data, ctx: CommandContext) {
        const d = data as unknown as BudgetStatusData;
        const over = d.remainingCents <= 0 && d.caps.dailyCapCents > 0;
        const total = `${formatCents(d.spentCents)} of ${formatCents(d.caps.dailyCapCents)} (${d.percent}%)`;
        const lines = [
          `  ${ctx.theme.emphasis("SPEND")} ${ctx.theme.value(d.date)} ${ctx.theme.meta(d.tz)}`,
          `  ${ctx.theme.meta("today   ")} ${over ? ctx.theme.needsApproval(total) : ctx.theme.value(total)} ${ctx.theme.meta(`${formatCents(d.remainingCents)} left of budget.daily_cap`)}`,
        ];
        if (d.bySurface.length === 0) lines.push(ctx.theme.meta("  nothing spent on this day"));
        for (const row of d.bySurface) {
          lines.push(`  ${ctx.theme.meta(row.surface.padEnd(8, " "))} ${ctx.theme.value(formatCents(row.cents))} ${ctx.theme.meta(`${row.cents} cents`)}`);
        }
        lines.push(`  ${ctx.theme.meta("caps    ")} ${ctx.theme.body(`budget.per_run_cap ${formatCents(d.caps.perRunCapCents)}, improve.sweep_cap_cents ${formatCents(d.caps.sweepCapCents)}`)}`);
        lines.push(`  ${ctx.theme.meta(`every surface appends to ${d.path}`)}`);
        return lines;
      },
    },
  ],
};
