/**
 * [C16] One attempt of one task on a Trent harness: the objective goes in, the orchestrator events come out,
 * the fake world is graded, and the attempt's cost is read back off the ledger rows the run wrote.
 *
 * A harness is a `TrentSession`: anything that runs an objective as an `OrcEvent` stream and takes the
 * approval decisions of that stream. Solo is `createSoloBenchSession` below (the shipped solo runner, the
 * shipped meter over the ledger, the bench's tool build) or, from the CLI, the headless runtime's own solo
 * runner (`trent run --solo` semantics); the fleet is the runtime's fleet runner (`fleet-runner.ts`). The
 * driver is the same for both, so the two are measured the same way.
 *
 * A gate frame is answered by the owner (`operator.ts`) on the call the frame names, BEFORE the next event is
 * pulled, which is when a decision continues the same stream (`solo/runner.ts`); the owner normally answers at
 * the tool seam instead and no gate frame appears at all.
 */
import { installSpendLedger, openSpendLedger, type SpendLedger, type SpendRow } from "../governance/spend-ledger.js";
import type { OrcEvent } from "../orchestrator/types.js";
import { createRunLedgerMeter } from "../solo/meter.js";
import { createSoloRunner } from "../solo/runner.js";
import { memorySoloSession } from "../solo/session-store.js";
import type { SoloConfig, SoloGateway, SoloRunner } from "../solo/types.js";
import { costOfRows, NO_COST } from "./cost.js";
import { carriesModelOutput, createFirstOutput, timedGateway, type FirstOutput } from "./first-output.js";
import { gradeTask } from "./grade.js";
import { heldCallOf, type BenchOperator } from "./operator.js";
import type { BenchTools } from "./tools.js";
import type { BenchTask, TaskRun } from "./types.js";
import type { BenchWorld } from "./world.js";

export interface TrentSession {
  readonly harness: "trent-solo" | "trent-fleet";
  run(objective: string, signal: AbortSignal): AsyncIterable<OrcEvent>;
  approve(runId: string, stepId: string): Promise<boolean>;
  reject(runId: string, stepId: string): Promise<boolean>;
  /** The ledger rows the run wrote, read after it settled. */
  spend(runId: string): readonly SpendRow[];
  /** The gateway's own first-output mark, when the session can wrap its gateway. */
  readonly firstOutput?: FirstOutput;
  /** Before every attempt: put back what the session needs installed in the process. */
  prepare?(): void;
}

export interface AttemptEnv {
  readonly world: BenchWorld;
  readonly operator: BenchOperator;
  /** Epoch milliseconds; the bench's one clock. */
  readonly now: () => number;
  /** An attempt still running after this long is aborted and graded as it stands. */
  readonly timeoutMs: number;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The owner's answer to a gate frame: the held call it names (`seatLoopState.pendingToolCall`), else a step gate. */
function answerGate(operator: BenchOperator, event: OrcEvent): boolean {
  const pending = (event.step as { seatLoopState?: { pendingToolCall?: { action?: string } } } | undefined)?.seatLoopState?.pendingToolCall;
  if (typeof pending?.action !== "string") return operator.approveStep(event.step?.title ?? event.detail ?? "a step");
  const held = heldCallOf(pending.action);
  return operator.decide(held.tool, held.args);
}

export async function runTrentAttempt(session: TrentSession, task: BenchTask, attempt: number, env: AttemptEnv): Promise<TaskRun> {
  env.world.reset(task.seed);
  env.operator.begin(task, env.world.decisionLog);
  session.prepare?.();
  session.firstOutput?.reset();
  const started = env.now();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error(`the bench's ${String(env.timeoutMs)} ms limit for one attempt`)), env.timeoutMs);
  let runId: string | undefined;
  let seenAt: number | undefined;
  let status: TaskRun["status"] = "error";
  let error: string | undefined = "the run ended without a verdict";
  try {
    for await (const event of session.run(task.objective, abort.signal)) {
      runId ??= event.runId;
      if (seenAt === undefined && carriesModelOutput(event)) seenAt = env.now();
      if (event.kind === "step_awaiting_approval" && event.step?.id !== undefined) {
        const decide = answerGate(env.operator, event) ? session.approve : session.reject;
        await decide.call(session, event.runId, event.step.id);
      } else if (event.kind === "run_done") {
        status = "completed";
        error = undefined;
      } else if (event.kind === "run_failed") {
        status = "failed";
        error = event.detail ?? event.run?.summary ?? "the run failed";
      } else if (event.kind === "run_cancelled") {
        status = abort.signal.aborted ? "timeout" : "cancelled";
        error = event.detail ?? "the run was cancelled";
      }
      if (abort.signal.aborted) break;
    }
    if (abort.signal.aborted && status === "error") {
      status = "timeout";
      error = message(abort.signal.reason);
    }
  } catch (caught) {
    status = abort.signal.aborted ? "timeout" : "error";
    error = message(abort.signal.aborted ? abort.signal.reason : caught);
  } finally {
    clearTimeout(timer);
  }
  const wallMs = Math.max(0, env.now() - started);
  const marks = [session.firstOutput?.at(), seenAt].filter((mark): mark is number => mark !== undefined);
  const grade = await gradeTask(task, env.world);
  const cost = runId === undefined ? NO_COST : costOfRows(session.spend(runId));
  return {
    taskId: task.id,
    taskClass: task.taskClass,
    harness: session.harness,
    attempt,
    passed: grade.passed,
    grade,
    status,
    wallMs,
    ttftMs: marks.length === 0 ? null : Math.max(0, Math.min(...marks) - started),
    ...cost,
    ...(error === undefined ? {} : { error }),
  };
}

export interface SoloBenchSessionInput {
  readonly gateway: SoloGateway;
  readonly tools: BenchTools;
  /** Where the ledger file lives: the rows an attempt's cost is read from. */
  readonly profileDir: string;
  readonly workspace: string;
  /** The model alias, sent as every request's pin. */
  readonly model?: string;
  /** Turn settings (`solo/turn-settings.ts`: constrained output on a local route, the tool-call cap). */
  readonly config?: SoloConfig;
  readonly now?: () => number;
}

/**
 * Solo without a profile: the shipped runner over the bench's tools, a fresh one-off conversation per attempt
 * (as `trent run` has), no memory or brain (a clean slate, as Hermes gets a fresh HERMES_HOME), and the
 * shipped meter writing the one ledger. The tests drive it with a scripted gateway; the CLI drives the
 * headless runtime's own solo runner instead (`fleet-runner.ts` `createRunnerBenchSession`).
 */
export function createSoloBenchSession(input: SoloBenchSessionInput): TrentSession & { readonly ledger: SpendLedger } {
  const ledger = openSpendLedger({ profileDir: input.profileDir });
  const firstOutput = createFirstOutput(input.now ?? Date.now);
  const gateway = timedGateway(input.gateway, firstOutput);
  let runner: SoloRunner | undefined;
  return {
    harness: "trent-solo",
    ledger,
    firstOutput,
    prepare: () => installSpendLedger(ledger),
    run(objective, signal) {
      runner = createSoloRunner({
        gateway,
        tools: { adapters: input.tools.adapters, bindings: input.tools.bindings },
        session: memorySoloSession(),
        memory: async () => ({ stable: [], context: [] }),
        meter: createRunLedgerMeter({ surface: "bench", companyId: "bench" }),
        config: { ...(input.model === undefined ? {} : { model: input.model }), ...(input.config ?? {}) },
        workspace: input.workspace,
        companyId: "bench",
      });
      return runner.run({ objective, signal });
    },
    approve: async (runId, stepId) => (runner === undefined ? false : runner.approve(runId, stepId)),
    reject: async (runId, stepId) => (runner === undefined ? false : runner.reject(runId, stepId)),
    spend: (runId) => ledger.rows().filter((row) => row.run_id === runId),
  };
}
