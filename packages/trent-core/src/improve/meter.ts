/**
 * The sweep's meter: every provider call the loop makes, counted per phase in integer cents from
 * the gateway's real usage, and an optional hard budget (Archon treats the call budget as an
 * input; CS329A analysis section 4, item 5).
 *
 * The meter wraps the injected `actuals`, `judge` and `reflect` functions. Each wrapper checks the
 * budget BEFORE the call and records the cost AFTER it, so the report can never under-count and a
 * sweep can overshoot its budget by at most one call. Exhaustion is a thrown `BudgetExhaustedError`
 * the sweep turns into `blockedBy: "budget_exhausted"`; nothing is estimated from a table.
 *
 * Phases: `baseline` (the seat prompt as it is), `candidate` (a skill draft under gate),
 * `gepa` (the reflection call and the proposal under gate), `judge` (every judge call, whichever
 * phase asked for it), `rationalise` (one call per distilled golden, task I.14). Cache hits are
 * not calls and cost nothing.
 */

import type { ActualsRunner, JudgeFn } from "./gate.js";
import type { ReflectFn } from "./gepa-pass.js";
import type { RationaleFn } from "./rationalise.js";

export type SweepPhase = "baseline" | "candidate" | "gepa" | "judge" | "rationalise";

export interface PhaseTally {
  calls: number;
  /** Integer cents. */
  costCents: number;
}

export type PhaseReport = Record<SweepPhase, PhaseTally>;

export class BudgetExhaustedError extends Error {
  constructor(
    readonly spentCents: number,
    readonly limitCents: number,
  ) {
    super(`sweep budget exhausted: ${spentCents} of ${limitCents} cents spent`);
    this.name = "BudgetExhaustedError";
  }
}

export function isBudgetExhausted(error: unknown): error is BudgetExhaustedError {
  return error instanceof BudgetExhaustedError;
}

export function emptyPhases(): PhaseReport {
  return {
    baseline: { calls: 0, costCents: 0 },
    candidate: { calls: 0, costCents: 0 },
    gepa: { calls: 0, costCents: 0 },
    judge: { calls: 0, costCents: 0 },
    rationalise: { calls: 0, costCents: 0 },
  };
}

function cents(value: number | undefined): number {
  return Math.max(0, Math.trunc(value ?? 0));
}

export class SweepMeter {
  readonly phases: PhaseReport = emptyPhases();
  #phase: SweepPhase = "baseline";
  #exhausted = false;

  constructor(readonly limitCents: number | undefined) {
    if (limitCents !== undefined && (!Number.isInteger(limitCents) || limitCents < 0)) {
      throw new Error(`budgetCents must be a non-negative integer, got ${String(limitCents)}`);
    }
  }

  /** Sweep phases run strictly one after another, so the current phase is a single value. */
  enter(phase: Exclude<SweepPhase, "judge" | "rationalise">): void {
    this.#phase = phase;
  }

  get phase(): SweepPhase {
    return this.#phase;
  }

  /** Runs `fn` as `phase`, then restores the phase the caller was in (the baseline is measured on demand). */
  async within<T>(phase: Exclude<SweepPhase, "judge" | "rationalise">, fn: () => Promise<T>): Promise<T> {
    const previous = this.#phase;
    this.#phase = phase;
    try {
      return await fn();
    } finally {
      this.#phase = previous;
    }
  }

  get spentCents(): number {
    return Object.values(this.phases).reduce((sum, p) => sum + p.costCents, 0);
  }

  get exhausted(): boolean {
    return this.#exhausted;
  }

  /** Throws before a call would start with nothing left to pay for it. */
  private assertBudget(): void {
    if (this.limitCents === undefined) return;
    if (this.spentCents >= this.limitCents) {
      this.#exhausted = true;
      throw new BudgetExhaustedError(this.spentCents, this.limitCents);
    }
  }

  private record(phase: SweepPhase, costCents: number | undefined): void {
    this.phases[phase].calls += 1;
    this.phases[phase].costCents += cents(costCents);
    if (this.limitCents !== undefined && this.spentCents >= this.limitCents) this.#exhausted = true;
  }

  actuals(inner: ActualsRunner): ActualsRunner {
    return async (input) => {
      this.assertBudget();
      const phase = this.#phase;
      const out = await inner(input);
      this.record(phase, out.costCents);
      return out;
    };
  }

  judge(inner: JudgeFn): JudgeFn {
    return async (input) => {
      this.assertBudget();
      const verdict = await inner(input);
      this.record("judge", verdict.costCents);
      return verdict;
    };
  }

  /** The rationale call of task I.14: one per golden, always under its own phase. */
  rationale(inner: RationaleFn): RationaleFn {
    return async (prompt) => {
      this.assertBudget();
      const out = await inner(prompt);
      this.record("rationalise", out.costCents);
      return out;
    };
  }

  /** A reflection model may return plain text (cost unknown, counted as a call at 0 cents) or text with its cost. */
  reflect(inner: ReflectFn): ReflectFn {
    return async (prompt) => {
      this.assertBudget();
      const out = await inner(prompt);
      if (typeof out === "string") {
        this.record("gepa", 0);
        return out;
      }
      this.record("gepa", out.costCents);
      return out;
    };
  }
}
