/**
 * [C16] A runtime's runner as a bench harness: the fleet (`trent-fleet`), and solo when it is the headless
 * runtime's own solo runner (`trent run --solo` semantics) rather than the profile-less one in
 * `trent-runner.ts`. The CLI builds the runtime (`apps/cli/src/commands/groups/bench.ts`) with the bench's tool
 * build in place of the profile's and hands its `runnerFor(mode)` here.
 *
 * Each attempt is a one-off run, as `trent run` starts one: trigger `manual`, charged to surface `bench`, and a
 * hold that reaches a gate frame parks (the owner is attached; `solo/hold-policy.ts` `park`). The run's cost is
 * the rows the run scope wrote to the profile's ledger at close, whatever roles the run had: the fleet's
 * planner, critic, consolidator and seats each write their own. The fleet's seats call the app's gateway,
 * which nothing here can wrap, so its first output is read off the frames (`first-output.ts`).
 */
import { openSpendLedger } from "../governance/spend-ledger.js";
import type { OrcEvent } from "../orchestrator/types.js";
import type { FirstOutput } from "./first-output.js";
import type { TrentSession } from "./trent-runner.js";

/** The slice of the CLI's `ModeRunner` (`apps/cli/src/runtime/runner-for-mode.ts`) an attempt drives. */
export interface BenchModeRunner {
  run(input: { readonly objective: string; readonly signal?: AbortSignal; readonly trigger?: "manual"; readonly surface?: string; readonly holds?: "park" }): AsyncIterable<OrcEvent>;
  approve(runId: string, stepId: string): Promise<boolean>;
  reject(runId: string, stepId: string): Promise<boolean>;
}

export const BENCH_SURFACE = "bench";

export interface RunnerSessionInput {
  readonly harness: TrentSession["harness"];
  readonly runner: BenchModeRunner;
  /** The profile whose ledger the runtime writes (`<profile>/spend.ndjson`). */
  readonly profileDir: string;
  /** The runtime's gateway mark, when the CLI could wrap it (solo); absent for the fleet. */
  readonly firstOutput?: FirstOutput;
  readonly prepare?: () => void;
}

export function createRunnerBenchSession(input: RunnerSessionInput): TrentSession {
  const ledger = openSpendLedger({ profileDir: input.profileDir });
  return {
    harness: input.harness,
    ...(input.firstOutput === undefined ? {} : { firstOutput: input.firstOutput }),
    ...(input.prepare === undefined ? {} : { prepare: input.prepare }),
    run: (objective, signal) => input.runner.run({ objective, signal, trigger: "manual", surface: BENCH_SURFACE, holds: "park" }),
    approve: (runId, stepId) => input.runner.approve(runId, stepId),
    reject: (runId, stepId) => input.runner.reject(runId, stepId),
    spend: (runId) => ledger.rows().filter((row) => row.run_id === runId),
  };
}
