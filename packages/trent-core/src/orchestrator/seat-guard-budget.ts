/**
 * The per-seat spend cap, enforced (B2, audit shortfall 10).
 *
 * `budgetCentsPerRun` from the app's manifest was rendered into the seat's prompt and written onto
 * the subtask, and nothing ever compared it to spend: `grep -n budget apps/web/lib/seat-agent-loop.ts`
 * returns nothing, and the loop's `costCents` accumulator is never capped. `apps/web` is read-only,
 * so the cap is enforced where the wrapper already sees every seat call and its cost — the seat
 * guard port (`./seat-guard.ts`).
 *
 * Rules:
 *   - one ledger per RUN, one purse per SEAT in it;
 *   - a call is never pre-billed: the first call always runs, because no one knows a turn's cost
 *     before the provider answers;
 *   - past the cap the seat's loop is ABORTED — the next call never reaches a model and comes back
 *     as a final turn, which is what `seat-agent-loop.ts:302` returns on instead of asking again;
 *   - the step ends `failed` with the spend and the cap named in INTEGER CENTS, never dollars,
 *     and one `step_note` event carries the same two numbers.
 */

import { seatCapability } from "../fleet/seat-capabilities.js";
import { guardSeatModel, type SeatTally, type SeatModelFn, type SeatModelResult } from "./seat-guard.js";
import type { OrcEvent, SeatChatCompletionFn } from "./types.js";

/** One seat's cap, broken. Both numbers are integer cents. */
export interface SeatBudgetBreach {
  readonly seat: string;
  readonly stepId: string;
  readonly spentCents: number;
  readonly capCents: number;
  readonly message: string;
}

/** The per-run cap for a seat, in integer cents. `undefined` means the seat is uncapped. */
export type SeatCapLookup = (seat: string) => number | undefined;

/** The manifest's own cap for the seat, or nothing when the application defines no such seat. */
export const manifestSeatCap: SeatCapLookup = (seat) => {
  try {
    return seatCapability(seat).budgetCents;
  } catch {
    return undefined;
  }
};

function breachMessage(seat: string, spentCents: number, capCents: number): string {
  return `${seat} seat budget exceeded: spent ${spentCents} cents against a per-run cap of ${capCents} cents`;
}

/** One run's spend, per seat. Writes a breach through to the guard's tally so the step fails. */
export class SeatBudgetLedger {
  readonly #tally: SeatTally;
  readonly #caps: SeatCapLookup;
  readonly #spent = new Map<string, number>();
  readonly #breaches = new Map<string, SeatBudgetBreach>();

  constructor(tally: SeatTally, caps: SeatCapLookup = manifestSeatCap) {
    this.#tally = tally;
    this.#caps = caps;
  }

  /** The seat's per-run cap in integer cents, or undefined when it has none. */
  capFor(seat: string): number | undefined {
    const cap = this.#caps(seat);
    return cap === undefined || !Number.isFinite(cap) || cap <= 0 ? undefined : Math.trunc(cap);
  }

  /** What this seat has spent so far in this run, in integer cents. */
  spent(seat: string): number {
    return this.#spent.get(seat) ?? 0;
  }

  /** The breach recorded for this seat in this run, if it has one. */
  breachFor(seat: string): SeatBudgetBreach | undefined {
    return this.#breaches.get(seat);
  }

  /** Adds one call's cost. Returns the breach the moment the accumulated spend passes the cap. */
  record(seat: string, stepId: string, costCents: number): SeatBudgetBreach | undefined {
    const cost = Number.isFinite(costCents) ? Math.max(0, Math.trunc(costCents)) : 0;
    const spentCents = this.spent(seat) + cost;
    this.#spent.set(seat, spentCents);
    const capCents = this.capFor(seat);
    if (capCents === undefined || spentCents <= capCents) return undefined;
    const existing = this.#breaches.get(seat);
    if (existing !== undefined) return existing;
    const breach: SeatBudgetBreach = { seat, stepId, spentCents, capCents, message: breachMessage(seat, spentCents, capCents) };
    this.#breaches.set(seat, breach);
    // The guard's tally is what `shapeEvent` and the end-of-run override read: the step this seat
    // was running is failed outright, however well the model call itself went.
    this.#tally.abort(stepId, breach.message);
    return breach;
  }
}

/** What a refused call hands back: a FINAL turn, so the app's seat loop stops asking. */
function refusal(breach: SeatBudgetBreach): SeatModelResult {
  return {
    output: {
      summary: breach.message,
      findings: [],
      recommendations: [],
      riskNotes: [`The ${breach.seat} seat stopped at its per-run cap of ${breach.capCents} cents.`],
      whatIDidNotDo: [`Finish this step: the seat had already spent ${breach.spentCents} cents.`],
      workRequests: [],
    },
    model: "",
    tokens: 0,
    costCents: 0,
    fallback: false,
    error: breach.message,
  };
}

/**
 * Wraps the seat executor with the cap. Installed OUTSIDE `guardSeatModel` so a refused call is
 * never recorded as a provider failure on the tally — the provider was never asked.
 */
export function budgetGuard(underlying: SeatModelFn, ledger: SeatBudgetLedger, emit?: (event: OrcEvent) => void): SeatModelFn {
  return async (input) => {
    const seat = input.subtask.seat;
    const broken = ledger.breachFor(seat);
    if (broken !== undefined) return refusal(broken);
    const result = await underlying(input);
    const breach = ledger.record(seat, input.subtask.id, result.costCents);
    if (breach !== undefined) {
      emit?.({
        kind: "step_note",
        runId: "",
        at: new Date().toISOString(),
        step: { id: breach.stepId, agentRole: breach.seat },
        detail: breach.message,
      });
    }
    return result;
  };
}

/**
 * The seat executor with BOTH guards on it, and this run's purse. One call per run: the
 * orchestrator installs the result through the app's DI seam. The cap sits OUTSIDE the seat guard,
 * so a refused call — which never reached a provider — is never tallied as a provider failure.
 */
export function guardedSeatModel(input: {
  readonly underlying: SeatModelFn;
  readonly chat?: SeatChatCompletionFn | undefined;
  readonly tally: SeatTally;
  readonly instructions?: ReadonlyMap<string, string>;
  readonly emit?: (event: OrcEvent) => void;
  /** Overrides the manifest caps; tests pass their own. */
  readonly caps?: SeatCapLookup;
}): SeatModelFn {
  const ledger = new SeatBudgetLedger(input.tally, input.caps ?? manifestSeatCap);
  return budgetGuard(guardSeatModel(input.underlying, input.chat, input.tally, input.instructions), ledger, input.emit);
}
