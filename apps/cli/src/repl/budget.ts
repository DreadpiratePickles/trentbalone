/**
 * 3.7 — the budget ticker.
 *
 * Costs arrive as INTEGER CENTS from the gateway's usage events and from the
 * orchestrator's per-step `costCents`. Nothing here is ever a float; dollars exist only
 * in `formatCents`, at the edge, for display. Alert thresholds are percentages read
 * from `config.budget.alert_thresholds` — never a literal in this file.
 */

import type { SpendLedger } from "@trent/core/governance/index.js";

import type { Theme } from "../ui/index.js";

/**
 * [G3] The day's shared ledger, as this ticker uses it: read the total every surface has written,
 * write this surface's own costs back. Only the two methods are required, so a test needs no file.
 */
export type SpendLedgerPort = Pick<SpendLedger, "append" | "dailyTotalCents">;

/** What the REPL knows about a cost beyond its cents; each field rides into the ledger row. */
export interface BudgetChargeMeta {
  model?: string;
  provider?: string;
  tokens?: number;
  seat?: string;
  runId?: string;
}

export interface BudgetLedgerOptions {
  /** Daily cap in integer cents (`config.budget.daily_cap`). */
  capCents: number;
  /** Percentages (`config.budget.alert_thresholds`). */
  thresholds: readonly number[];
  /** Cents already spent today, if a previous session is being resumed. Ignored when `spend` is wired. */
  openingCents?: number;
  /** Per-run cap in integer cents (`config.budget.per_run_cap`). Zero or absent disables it. */
  perRunCapCents?: number;
  /**
   * [G3] The profile's shared spend ledger. With one, the daily figure IS the day's cross-surface
   * total: the ticker opens on what `trent run`, the gateway, cron and the heartbeat have already
   * spent today, every cost recorded here is written back for them, and the refusal is measured
   * against that total rather than against this session. Without one, nothing changes.
   */
  spend?: SpendLedgerPort;
  /** The surface tag written to the ledger. Defaults to the REPL, which is what this ticker serves. */
  surface?: string;
  /** The run these costs belong to, when the surface knows it. */
  runId?: string;
  now?: () => Date;
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
/** The surface this ticker serves; the TUI renders the same ledger. */
const DEFAULT_SURFACE = "repl";
/** Written when the cost arrived without the model or provider that was billed. */
const UNATTRIBUTED = "unattributed";

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
  readonly #spend: SpendLedgerPort | undefined;
  readonly #surface: string;
  readonly #runId: string;
  readonly #now: () => Date;

  constructor(options: BudgetLedgerOptions) {
    this.capCents = options.capCents;
    this.perRunCapCents = options.perRunCapCents ?? 0;
    this.#thresholds = [...options.thresholds].sort((a, b) => a - b);
    this.#spend = options.spend;
    this.#surface = options.surface ?? DEFAULT_SURFACE;
    this.#runId = options.runId ?? "";
    this.#now = options.now ?? ((): Date => new Date());
    // The day's opening figure: the shared ledger when there is one, the caller's resumed total
    // otherwise. A session that starts after the gateway spent the cap starts already refused.
    this.#spent = this.#spend === undefined ? options.openingCents ?? 0 : this.#spend.dailyTotalCents(this.#now());
    this.#announce();
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

  /**
   * Records one real cost. Rejects floats, because money is integer cents. With a shared ledger
   * the cost is written there first and the daily figure is then re-read from it, so this session
   * and every other surface are reading one number.
   */
  record(costCents: number, meta?: BudgetChargeMeta): void {
    if (!Number.isInteger(costCents)) {
      throw new TypeError(`budget costs must be integer cents, received ${costCents}`);
    }
    this.#runSpent += costCents;
    if (this.#spend === undefined) {
      this.#spent += costCents;
    } else {
      this.#spend.append({
        surface: this.#surface,
        run_id: meta?.runId ?? this.#runId,
        ...(meta?.seat === undefined ? {} : { seat: meta.seat }),
        model: meta?.model ?? UNATTRIBUTED,
        provider: meta?.provider ?? UNATTRIBUTED,
        cents: costCents,
        tokens: Math.trunc(meta?.tokens ?? 0),
      });
      this.#refresh();
    }
    this.#announce();
  }

  /** Re-reads the day's cross-surface total. Cheap enough at a turn boundary; not per frame. */
  #refresh(): void {
    if (this.#spend !== undefined) this.#spent = this.#spend.dailyTotalCents(this.#now());
  }

  #announce(): void {
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
    // Another surface may have spent while this one sat idle, so the day's total is re-read here.
    this.#refresh();
    this.#announce();
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
