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
  readonly #thresholds: number[];
  #spent: number;
  #announced = new Set<number>();
  #pending: number[] = [];

  constructor(options: BudgetLedgerOptions) {
    this.capCents = options.capCents;
    this.#thresholds = [...options.thresholds].sort((a, b) => a - b);
    this.#spent = options.openingCents ?? 0;
  }

  get spentCents(): number {
    return this.#spent;
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

  /** True once any configured threshold has been crossed. */
  get warning(): boolean {
    return this.#announced.size > 0;
  }

  /** The ticker line. Ember once a threshold is live, haze otherwise. */
  render(theme: Theme): string {
    const text = `${formatCents(this.#spent)} / ${formatCents(this.capCents)} today (${this.percent}%)`;
    return this.warning ? theme.needsApproval(text) : theme.meta(text);
  }

  /** The one-line warning shown as a threshold is crossed. */
  warningLine(threshold: number, theme: Theme): string {
    return theme.needsApproval(
      `Budget alert: ${threshold}% of the daily cap used (${formatCents(this.#spent)} of ${formatCents(this.capCents)}).`,
    );
  }
}
