/**
 * D4 — what happens at the very end of a run, after the last job has drained.
 *
 * Two things live here. The goal hook: if this run belongs to a goal, its quality gates run before
 * any judge is consulted, and a red one ends the run `gated` with the gate's own output as the next
 * run's starting point. And `verify_on_stop`: if the checkpoint ledger says this turn wrote files
 * and nothing verified them afterwards, the run ends `unverified` and says what was edited and what
 * would settle it.
 *
 * Neither verdict can be expressed as an `OrchestrationRunStatus`: that union is a hand-kept mirror
 * of `apps/web/lib/orchestrator.ts` and growing it would make the mirror a lie. So the verdict is
 * read off the port by whoever wants it, and the REASON rides the bus as a `step_note` — the kind
 * the pipeline already uses for a remark about a run in flight, and the same road the fleet-memory
 * hook's pressure notices take (`run-hooks.ts`). A surface that renders events therefore prints the
 * refusal with no change of its own.
 *
 * `applyConsolidation` lives here rather than in `index.ts` for one flat reason: `index.ts` is at
 * the repository's 500-line ceiling, and this is a run-end write like the two above it.
 */

import { activeCheckpointSession } from "../checkpoints/index.js";
import {
  activeGoalSession,
  finishGoalRun,
  turnWrites,
  type GoalJudge,
  type GoalRecord,
  type GoalSession,
  type LedgerRow,
  type RunVerdict,
} from "../goals/index.js";
import type { Libs } from "./libs.js";
import type { OrcEvent } from "./types.js";

/** Writes the wrapper's consolidated brief where the snapshot and the store read it. */
export async function applyConsolidation(libs: Libs, runId: string, summary: string): Promise<void> {
  const live = libs.orchestrator.getOrchestrationRun(runId);
  if (live) {
    live.summary = summary;
    libs.cache.cacheOrchestrationRun(live);
  }
  await libs.store.updateOrchestratorRun(runId, { summary }).catch(() => undefined);
}

export interface RunVerificationInput {
  readonly runId: string;
  readonly objective: string;
  /** The run's own event deliverer, so a refusal reaches whoever is streaming it. */
  readonly deliver: (event: OrcEvent) => void;
}

export interface RunVerificationPort {
  finish(input: RunVerificationInput): Promise<void>;
  /** The verdict for a finished run, until this port is dropped. */
  verdict(runId: string): RunVerdict | undefined;
}

/** The checkpoint session as this hook reads it; `CheckpointSession` satisfies it structurally. */
export interface CheckpointView {
  readonly runId: string;
  readonly turn: number;
  readonly store: { entries(runId: string): readonly LedgerRow[] };
}

export interface GoalVerificationDeps {
  /** The goal session; defaults to the process's own, opened by the runtime. */
  readonly session?: () => GoalSession | undefined;
  /** The checkpoint ledger; defaults to the process's own, opened by the runtime. */
  readonly checkpoints?: () => CheckpointView | undefined;
  /** The model judge, consulted only behind green gates. Absent, the gates are the whole verdict. */
  readonly judge?: GoalJudge;
}

/** Runs past the cap are dropped oldest first: the port outlives runs, so it must not grow with them. */
const MAX_REMEMBERED_VERDICTS = 64;

export function createGoalVerificationPort(deps: GoalVerificationDeps = {}): RunVerificationPort {
  const verdicts = new Map<string, RunVerdict>();
  const session = (): GoalSession | undefined => (deps.session ?? activeGoalSession)();
  const checkpoints = (): CheckpointView | undefined =>
    deps.checkpoints === undefined ? (activeCheckpointSession() as CheckpointView | undefined) : deps.checkpoints();

  return {
    async finish(input) {
      const goals = session();
      if (goals === undefined) return;
      const goalId = goals.activeGoalId;
      const goal: GoalRecord | undefined = goalId === undefined ? undefined : goals.store.get(goalId);
      const ledger = checkpoints();
      const rows = ledger === undefined ? [] : ledger.store.entries(ledger.runId);

      const verdict = await finishGoalRun({
        runId: input.runId,
        ...(goal === undefined ? {} : { goal }),
        ...(goals.backend === undefined ? {} : { backend: goals.backend }),
        store: goals.store,
        ...(deps.judge === undefined ? {} : { judge: deps.judge }),
        evidence: goals.evidence,
        verify: {
          enabled: goals.config.verify_on_stop,
          writes: ledger === undefined ? [] : turnWrites(rows, ledger.turn),
          evidence: goals.evidence.all(),
          commands: goals.config.verify_commands,
        },
      });

      if (verdicts.size >= MAX_REMEMBERED_VERDICTS) verdicts.delete(verdicts.keys().next().value as string);
      verdicts.set(input.runId, verdict);
      // A completed run with nothing to say says nothing: only a refusal reaches the transcript.
      if (verdict.outcome !== "completed" && verdict.reason !== "") {
        input.deliver({ kind: "step_note", runId: input.runId, at: new Date().toISOString(), detail: verdict.reason });
      }
      // The next turn starts with no evidence of its own, so the last one's cannot vouch for it.
      goals.evidence.clear();
    },
    verdict: (runId) => verdicts.get(runId),
  };
}

/** Runs the hook when one is wired. A runtime with no goals and no ledger wires none. */
export async function finishRunVerification(
  port: RunVerificationPort | undefined,
  input: RunVerificationInput,
): Promise<void> {
  await port?.finish(input);
}
