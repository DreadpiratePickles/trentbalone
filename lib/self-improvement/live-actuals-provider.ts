/**
 * Live Actuals Provider — Slice 2 of the autoresearch loop.
 *
 * Slice 1 scored candidates against REPLAYED actuals (see actuals-provider.ts):
 * deterministic and zero-spend, but a candidate could never actually change the
 * score. This provider closes that gap: it runs the FIXED orchestrator under a
 * candidate overlay (a new/edited SKILL.md) to produce FRESH outputs, so a
 * delta on the frozen suite is real.
 *
 * Seam discipline (matches Slice 1 exactly):
 *   - It still implements the synchronous `ActualsProvider` interface, so
 *     everything downstream (frozen suite → eval gate → promotion) is unchanged.
 *   - Live execution is async, so callers `await provider.prime(fixtures)` once;
 *     `get(fixtureId)` then serves the cached run output synchronously.
 *
 * Safety (non-negotiable):
 *   - The orchestrator itself is INJECTED (`OrchestratorRunner`). This module
 *     never imports `lib/orchestrator.ts` — the real adapter wires it at the
 *     edge, and unit tests stub it (no real LLM, no spend).
 *   - Every run is bounded by `budgetCentsPerRun` and a `totalBudgetCents` cap;
 *     an injected `budgetGuard` enforces the company spend cap / reservation.
 *   - An injected `killSwitch` aborts all live execution (no runs, no spend).
 *   - It produces NO live-tenant side effects beyond bounded, reserved spend;
 *     the candidate only ever runs in eval, never against the live skill set.
 */

import type { ActualsProvider, FixtureActual } from "@/lib/self-improvement/actuals-provider";

/** The candidate being evaluated, overlaid onto the fixed harness for each run. */
export type CandidateOverlay = {
  /** Skill / task type the candidate applies to. */
  taskType: string;
  /** Candidate SKILL.md content (the editable layer under test). */
  skillContent: string;
  /** Optional candidate id for audit/correlation. */
  candidateId?: string;
};

/** One bounded candidate run for a single fixture. */
export type LiveRunRequest = {
  companyId: string;
  /** The frozen-suite fixture id this run produces an actual for. */
  fixtureId: string;
  /** The fixture's prompt/input (eval-harness `EvalFixture.input`). */
  input: unknown;
  overlay: CandidateOverlay;
  /** Hard ceiling for this single run, in cents. */
  budgetCents: number;
};

/** The output of one bounded candidate run. */
export type LiveRunResult = {
  /** Eval-harness-shaped output the frozen suite will grade. */
  actual: FixtureActual;
  /** Cents this run actually consumed (for the running total + reconciliation). */
  costCents: number;
};

/**
 * Seam: runs the FIXED orchestrator once under the candidate overlay and returns
 * its output. Injected so unit tests stub it and the real adapter (which wires
 * `lib/orchestrator.ts` + spend reservation) lives at the edge.
 */
export type OrchestratorRunner = (req: LiveRunRequest) => Promise<LiveRunResult>;

/**
 * Seam: company spend guard. The real adapter delegates to
 * `assertSpendAvailable` / `assertToolSpendAllowed` in `lib/spend.ts`. Throwing
 * denies the run (and stops priming — a cap denial is global).
 */
export type BudgetGuard = (companyId: string, cents: number, description: string) => Promise<void>;

/** Seam: returns true when autoresearch live execution is disabled (kill switch). */
export type KillSwitch = () => boolean | Promise<boolean>;

export type LiveActualsProviderOptions = {
  companyId: string;
  overlay: CandidateOverlay;
  runner: OrchestratorRunner;
  /** Per-fixture spend ceiling, cents. Default 25. */
  budgetCentsPerRun?: number;
  /** Total spend ceiling across all fixtures for this candidate, cents. Default 250. */
  totalBudgetCents?: number;
  /** Optional company spend guard (real adapter wires lib/spend.ts). */
  budgetGuard?: BudgetGuard;
  /** Optional kill switch; when it returns true, no runs happen. */
  killSwitch?: KillSwitch;
};

/** One fixture to execute the candidate against. */
export type PrimeFixture = { id: string; input: unknown };

export type PrimeReport = {
  /** Fixtures that produced a cached actual. */
  primed: number;
  /** Fixtures skipped (budget cap, kill switch, or run error). */
  skipped: number;
  /** Total cents consumed across all runs. */
  spentCents: number;
  /** True when the kill switch aborted the whole prime. */
  killed: boolean;
  /** Per-fixture run/budget errors (non-fatal — collected, never thrown). */
  errors: string[];
};

const DEFAULT_PER_RUN_CENTS = 25;
const DEFAULT_TOTAL_CENTS = 250;

export class LiveActualsProvider implements ActualsProvider {
  private readonly companyId: string;
  private readonly overlay: CandidateOverlay;
  private readonly runner: OrchestratorRunner;
  private readonly budgetCentsPerRun: number;
  private readonly totalBudgetCents: number;
  private readonly budgetGuard?: BudgetGuard;
  private readonly killSwitch?: KillSwitch;
  private readonly cache = new Map<string, FixtureActual>();
  private spentCents = 0;

  constructor(opts: LiveActualsProviderOptions) {
    this.companyId = opts.companyId;
    this.overlay = opts.overlay;
    this.runner = opts.runner;
    this.budgetCentsPerRun = opts.budgetCentsPerRun ?? DEFAULT_PER_RUN_CENTS;
    this.totalBudgetCents = opts.totalBudgetCents ?? DEFAULT_TOTAL_CENTS;
    this.budgetGuard = opts.budgetGuard;
    this.killSwitch = opts.killSwitch;
  }

  /**
   * Execute the candidate against every fixture, caching outputs for `get()`.
   * Bounded by per-run and total budget caps; honors the kill switch; never
   * throws (errors are collected into the report).
   */
  async prime(fixtures: readonly PrimeFixture[]): Promise<PrimeReport> {
    const report: PrimeReport = {
      primed: 0,
      skipped: 0,
      spentCents: 0,
      killed: false,
      errors: [],
    };

    if (await this.isKilled()) {
      report.killed = true;
      report.skipped = fixtures.length;
      return report;
    }

    for (const fixture of fixtures) {
      // Re-check the kill switch between runs so a mid-prime flip stops spend.
      if (await this.isKilled()) {
        report.killed = true;
        report.skipped += fixtures.length - (report.primed + report.skipped);
        break;
      }

      // Total cap: never start a run we can't afford in full.
      if (this.spentCents + this.budgetCentsPerRun > this.totalBudgetCents) {
        report.skipped += 1;
        continue;
      }

      // Company spend guard / reservation. A denial is global → stop priming.
      if (this.budgetGuard) {
        try {
          await this.budgetGuard(
            this.companyId,
            this.budgetCentsPerRun,
            `autoresearch live eval (${this.overlay.taskType}) ${fixture.id}`,
          );
        } catch (err) {
          report.errors.push(`budget[${fixture.id}]: ${errMsg(err)}`);
          report.skipped += 1;
          break;
        }
      }

      try {
        const result = await this.runner({
          companyId: this.companyId,
          fixtureId: fixture.id,
          input: fixture.input,
          overlay: this.overlay,
          budgetCents: this.budgetCentsPerRun,
        });
        this.cache.set(fixture.id, result.actual);
        this.spentCents += Math.max(0, result.costCents);
        report.primed += 1;
      } catch (err) {
        // A single run failure is non-fatal: record it and keep going.
        report.errors.push(`run[${fixture.id}]: ${errMsg(err)}`);
        report.skipped += 1;
      }
    }

    report.spentCents = this.spentCents;
    return report;
  }

  /** Synchronous seam: the recorded output of this fixture's primed run. */
  get(fixtureId: string): FixtureActual | undefined {
    return this.cache.get(fixtureId);
  }

  /** Cents consumed so far across primed runs. */
  get totalSpentCents(): number {
    return this.spentCents;
  }

  private async isKilled(): Promise<boolean> {
    if (!this.killSwitch) return false;
    return Boolean(await this.killSwitch());
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
