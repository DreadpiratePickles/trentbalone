/**
 * 3.7 — the budget ticker.
 *
 * Costs arrive as INTEGER CENTS from the gateway's usage events and from the
 * orchestrator's per-step `costCents`. Nothing here is ever a float; dollars exist only
 * in `formatCents`, at the edge, for display. Alert thresholds are percentages read
 * from `config.budget.alert_thresholds` — never a literal in this file.
 */

import type { Theme } from "../ui/index.js";

export interface BudgetLedgerOptions {
  /** Daily cap in integer cents (`config.budget.daily_cap`). */
  capCents: number;
  /** Percentages (`config.budget.alert_thresholds`). */
  thresholds: readonly number[];
  /** Cents already spent today, if a previous session is being resumed. */
  openingCents?: number;
  /** Per-run cap in integer cents (`config.budget.per_run_cap`). Zero or absent disables it. */
  perRunCapCents?: number;
}

/**
 * A cap that has been reached. The thresholds only warn; this is the refusal — the turn does not
 * start, and a run already in flight is stopped. Both figures are integer cents, never dollars.
 */
export interface BudgetStop {
  readonly kind: "daily" | "per_run";
  readonly capCents: number;
  readonly spentCents: number;
}

const DOLLAR = "$";
const CENTS_PER_UNIT = 100;

/** The one place cents become a dollar string. */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(cents));
  const units = Math.floor(abs / CENTS_PER_UNIT);
  const remainder = String(abs % CENTS_PER_UNIT).padStart(2, "0");
  return `${sign}${DOLLAR}${units}.${remainder}`;
}

export class BudgetLedger {
  readonly capCents: number;
  readonly perRunCapCents: number;
  readonly #thresholds: number[];
  #spent: number;
  #runSpent = 0;
  #announced = new Set<number>();
  #pending: number[] = [];

  constructor(options: BudgetLedgerOptions) {
    this.capCents = options.capCents;
    this.perRunCapCents = options.perRunCapCents ?? 0;
    this.#thresholds = [...options.thresholds].sort((a, b) => a - b);
    this.#spent = options.openingCents ?? 0;
  }

  get spentCents(): number {
    return this.#spent;
  }

  /** Cents spent by the run in progress. Reset by `beginRun()`. */
  get runSpentCents(): number {
    return this.#runSpent;
  }

  /** Percentage of the cap consumed, rounded down. */
  get percent(): number {
    if (this.capCents <= 0) return 0;
    return Math.floor((this.#spent * 100) / this.capCents);
  }

  /** Records one real cost. Rejects floats, because money is integer cents. */
  record(costCents: number): void {
    if (!Number.isInteger(costCents)) {
      throw new TypeError(`budget costs must be integer cents, received ${costCents}`);
    }
    this.#spent += costCents;
    this.#runSpent += costCents;
    for (const threshold of this.#thresholds) {
      if (this.percent >= threshold && !this.#announced.has(threshold)) {
        this.#announced.add(threshold);
        this.#pending.push(threshold);
      }
    }
  }

  /** Thresholds crossed since the last call. Each is announced exactly once. */
  takeCrossed(): number[] {
    return this.#pending.splice(0);
  }

  /** Opens a new run's allowance. The daily total is untouched. */
  beginRun(): void {
    this.#runSpent = 0;
  }

  /**
   * The cap that has been reached, or nothing. Checked before a turn starts — so a refusal costs
   * no model call — and again after every recorded cost, so a run that blows its per-run cap
   * mid-flight is stopped rather than merely warned about.
   */
  exceeded(): BudgetStop | null {
    if (this.capCents > 0 && this.#spent >= this.capCents) {
      return { kind: "daily", capCents: this.capCents, spentCents: this.#spent };
    }
    if (this.perRunCapCents > 0 && this.#runSpent >= this.perRunCapCents) {
      return { kind: "per_run", capCents: this.perRunCapCents, spentCents: this.#runSpent };
    }
    return null;
  }

  /** The refusal text, uncoloured. Integer cents, because that is what the cap is expressed in. */
  stopText(stop: BudgetStop): string {
    const name = stop.kind === "daily" ? "daily cap" : "per-run cap";
    const key = stop.kind === "daily" ? "budget.daily_cap" : "budget.per_run_cap";
    return `Budget stop: the ${name} of ${stop.capCents} cents is reached; ${stop.spentCents} cents are spent. Raise ${key} to continue.`;
  }

  /** The one-line refusal shown in place of the turn. */
  stopLine(stop: BudgetStop, theme: Theme): string {
    return theme.needsApproval(this.stopText(stop));
  }

  /** True once any configured threshold has been crossed. */
  get warning(): boolean {
    return this.#announced.size > 0;
  }

  /** The ticker text, uncoloured. The TUI paints it with Ink; the REPL with the theme. */
  summaryText(): string {
    return `${formatCents(this.#spent)} / ${formatCents(this.capCents)} today (${this.percent}%)`;
  }

  /** The ticker line. Ember once a threshold is live, haze otherwise. */
  render(theme: Theme): string {
    const text = this.summaryText();
    return this.warning ? theme.needsApproval(text) : theme.meta(text);
  }

  /** The warning text, uncoloured, for a surface that paints with something other than the theme. */
  warningText(threshold: number): string {
    return `Budget alert: ${threshold}% of the daily cap used (${formatCents(this.#spent)} of ${formatCents(this.capCents)}).`;
  }

  /** The one-line warning shown as a threshold is crossed. */
  warningLine(threshold: number, theme: Theme): string {
    return theme.needsApproval(this.warningText(threshold));
  }
}
