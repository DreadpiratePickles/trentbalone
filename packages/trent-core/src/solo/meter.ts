/**
 * [S1] The solo meter over the fleet's own run scope (`orchestrator/run-hooks.ts`).
 *
 * `open` opens the run's spend scope, `record` prices each call at the ANSWERING model's list price
 * and returns the whole cents newly due (what the step's `step_end` charges), `close` writes the
 * run's rows to the one daily ledger (`governance/spend-ledger.ts`), grouped by seat, model and
 * provider: a solo turn is one row per model, seat `trent`. Nothing here keeps a second ledger.
 *
 * The caps are the ones every surface already reads (`budget.per_run_cap`, `budget.daily_cap`):
 * `stopReason` says stop once this run's charged cents reach the per-run cap, or once the day's
 * ledger plus this run's charges not yet written reach the daily cap. It is asked before every
 * model call, so a stop never buys another token.
 */
import { closeRunScope, openRunScope, recordRunModelCall } from "../orchestrator/run-hooks.js";
import type { SoloMeter } from "./types.js";

export interface RunLedgerMeterOptions {
  /** The surface the run is charged to (`repl`, `run`, `gateway`, `cron`, `a2a`, ...). */
  readonly surface?: string;
  readonly companyId?: string;
  /** `budget.per_run_cap`, integer cents. Absent means no per-run stop. */
  readonly perRunCapCents?: number;
  /** `budget.daily_cap`, integer cents. Needs `ledger` to read the day's total. */
  readonly dailyCapCents?: number;
  readonly ledger?: { dailyTotalCents(date: Date | string): number };
  readonly now?: () => Date;
}

const cap = (value: number | undefined): number | undefined => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined);

export function createRunLedgerMeter(options: RunLedgerMeterOptions = {}): SoloMeter {
  const perRun = cap(options.perRunCapCents);
  const daily = cap(options.dailyCapCents);
  const now = options.now ?? (() => new Date());
  /**
   * Per run: `total` is every cent this process charged it, across a park and its resume (the
   * per-run cap); `unwritten` is the part the ledger has not been told yet (the daily cap adds it
   * to the ledger's own total, and `close` zeroes it because the ledger now holds it).
   */
  const charged = new Map<string, { total: number; unwritten: number }>();
  const of = (runId: string) => charged.get(runId) ?? { total: 0, unwritten: 0 };

  return {
    open(runId, objective) {
      charged.set(runId, of(runId));
      openRunScope([], runId, { companyId: options.companyId ?? "", objective, ...(options.surface === undefined ? {} : { surface: options.surface }) });
    },
    record(runId, call) {
      // A run nobody opened is attributed to no one by the scope; its frame still carries the gateway's own figure.
      const cents = recordRunModelCall(runId, call) ?? Math.max(0, Math.trunc(call.costCents));
      const held = of(runId);
      charged.set(runId, { total: held.total + cents, unwritten: held.unwritten + cents });
      return cents;
    },
    stopReason(runId) {
      const { total, unwritten } = of(runId);
      if (perRun !== undefined && total >= perRun) return `this run has spent ${total} cents of its ${perRun}-cent cap (budget.per_run_cap)`;
      if (daily !== undefined && options.ledger !== undefined) {
        const today = options.ledger.dailyTotalCents(now()) + unwritten;
        if (today >= daily) return `today's spend is ${today} cents of the ${daily}-cent daily cap (budget.daily_cap)`;
      }
      return undefined;
    },
    close(runId) {
      closeRunScope([], runId);
      charged.set(runId, { total: of(runId).total, unwritten: 0 });
    },
  };
}
