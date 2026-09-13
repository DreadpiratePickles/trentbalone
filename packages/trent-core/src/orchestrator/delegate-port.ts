/**
 * The orchestrator-side `DelegatePort`: how `delegate_task` reaches the run's existing delegation.
 *
 * The pipeline already knows one kind of delegation: a `[delegated]` child step in the same run,
 * routed to another seat, reading the shared memory but refused a write (`fleet-memory/README.md`
 * row 1). Until now only a seat's final `workRequests` could create one, and only AFTER the parent
 * step had finished, so the parent never saw the child's result. This port creates the same child
 * step from INSIDE the parent's tool loop, waits for it, and hands the result back as the tool's
 * output — the child's tool-call statuses untouched, so a `blocked` memory write stays `blocked`.
 *
 * The port learns which run and step is delegating the same way the fleet-memory hook learns the
 * caller: it wraps the seat executor and reads `subtask.id` / `subtask.seat` on every call. Nested
 * calls (a child that delegates) are the same mechanism one level deeper.
 *
 * The child is executed by a `DelegatedChildRunner`. The real one (`delegate-child.ts`) drives the
 * app's `executeStepWithRuntime`; tests pass a fake. The caps mirror `orchestrator-delegation.ts`:
 * six delegated steps per run, two levels deep.
 */
import { randomBytes } from "node:crypto";
import type { DelegatePort, DelegateRequest, DelegateResult } from "../tools/delegate/types.js";
import type { ToolCallRecord } from "../tools/types.js";
import type { SeatModelFn } from "./seat-guard.js";

/** `MAX_DELEGATED_STEPS_PER_RUN` in `apps/web/lib/orchestrator-delegation.ts`. */
export const DELEGATE_MAX_CHILDREN = 6;
/** `MAX_DELEGATION_DEPTH` in `apps/web/lib/orchestrator-delegation.ts`. */
export const DELEGATE_MAX_DEPTH = 2;

export interface DelegatedChildSpec {
  /** Assigned by the port before the child runs, so a nested `delegate_task` knows its depth. */
  readonly stepId: string;
  readonly runId: string;
  readonly companyId: string;
  readonly parentStepId: string;
  readonly parentSeat: string;
  readonly task: string;
  readonly context?: string;
  /** The seat the caller asked for; the runner routes when absent. */
  readonly agent?: string;
  /** 1 for a child of a planned step, 2 for a grandchild. */
  readonly depth: number;
}

export interface DelegatedChildOutcome {
  readonly agent: string;
  readonly status: DelegateResult["status"];
  readonly output: string;
  readonly toolCalls: readonly ToolCallRecord[];
}

/** What executes one child: the app pipeline, or a fake orchestrator in tests. */
export interface DelegatedChildRunner {
  /** How many `[delegated]` steps the run already holds, whoever created them. */
  delegatedCount(runId: string): Promise<number>;
  run(spec: DelegatedChildSpec): Promise<DelegatedChildOutcome>;
}

export interface OrchestratorDelegatePort extends DelegatePort {
  /** Wraps the seat executor so the port knows which run and step every call belongs to. */
  wrapSeatModel(fn: SeatModelFn): SeatModelFn;
  runStarted(input: { runId: string; companyId: string; objective: string }): void;
  runFinished(runId: string): void;
}

export interface OrchestratorDelegatePortOptions {
  readonly runner: DelegatedChildRunner;
  readonly maxChildren?: number;
  readonly maxDepth?: number;
}

interface ActiveRun {
  readonly runId: string;
  readonly companyId: string;
}

interface Caller {
  readonly run: ActiveRun;
  readonly stepId: string;
  readonly seat: string;
  readonly depth: number;
}

function failed(output: string): DelegateResult {
  return { status: "failed", output };
}

/** The same shape as the app's `makeId("step")`: a prefix, then a short random token. */
function childStepId(): string {
  return `step_${randomBytes(6).toString("hex")}`;
}

export function createOrchestratorDelegatePort(options: OrchestratorDelegatePortOptions): OrchestratorDelegatePort {
  const maxChildren = options.maxChildren ?? DELEGATE_MAX_CHILDREN;
  const maxDepth = options.maxDepth ?? DELEGATE_MAX_DEPTH;
  const runs = new Map<string, ActiveRun>();
  /** The depth of every child step this port created, so a child that delegates is one level deeper. */
  const depths = new Map<string, number>();
  /** Children started but not yet finished, per run: one call with several tasks must not beat the cap. */
  const inflight = new Map<string, number>();
  let current: ActiveRun | undefined;
  /** The seat call most recently started: the step whose tool loop is executing `delegate_task`. */
  let caller: Caller | undefined;

  return {
    wrapSeatModel(fn) {
      return async (input) => {
        if (current !== undefined) {
          caller = { run: current, stepId: input.subtask.id, seat: input.subtask.seat, depth: depths.get(input.subtask.id) ?? 0 };
        }
        return fn(input);
      };
    },
    runStarted(input) {
      const run: ActiveRun = { runId: input.runId, companyId: input.companyId };
      runs.set(input.runId, run);
      current = run;
    },
    runFinished(runId) {
      runs.delete(runId);
      if (caller?.run.runId === runId) caller = undefined;
      if (current?.runId === runId) current = runs.values().next().value;
    },
    async delegate(request: DelegateRequest): Promise<DelegateResult> {
      if (current === undefined) return failed("delegate_task: no orchestration run is active, so nothing was delegated.");
      const parent = caller;
      if (parent === undefined) return failed("delegate_task: no seat is executing a step, so nothing was delegated.");
      const depth = parent.depth + 1;
      if (depth > maxDepth) {
        return { status: "blocked", output: `delegate_task: delegation depth ${depth} exceeds the cap of ${maxDepth}; do this part yourself.` };
      }
      const runId = parent.run.runId;
      const existing = (await options.runner.delegatedCount(runId)) + (inflight.get(runId) ?? 0);
      if (existing >= maxChildren) {
        return { status: "blocked", output: `delegate_task: the run's delegation budget of ${maxChildren} delegated steps is spent; do this part yourself.` };
      }
      const stepId = childStepId();
      depths.set(stepId, depth);
      const spec: DelegatedChildSpec = {
        stepId,
        runId: parent.run.runId,
        companyId: parent.run.companyId,
        parentStepId: parent.stepId,
        parentSeat: parent.seat,
        task: request.task,
        ...(request.context === undefined ? {} : { context: request.context }),
        ...(request.agent === undefined ? {} : { agent: request.agent }),
        depth,
      };
      inflight.set(runId, (inflight.get(runId) ?? 0) + 1);
      try {
        const outcome = await options.runner.run(spec);
        return { status: outcome.status, output: outcome.output, agent: outcome.agent, runId, toolCalls: [...outcome.toolCalls] };
      } catch (error) {
        return failed(`delegate_task failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        inflight.set(runId, (inflight.get(runId) ?? 1) - 1);
      }
    },
  };
}
