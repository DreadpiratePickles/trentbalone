/**
 * The A2A task lifecycle, with NO transport in it.
 *
 * A delegated task is one real run on the injected {@link AgentRunner}: it is created `submitted`,
 * moves to `working` when the run starts, and settles `completed`, `failed` or `input-required`
 * according to what the run's event stream actually reported. Nothing here composes an answer —
 * the artifact text is the run's own summary (AGENTS.md invariant 2).
 *
 * The current HTTP shape (`POST /a2a/tasks` with Trent's own payload) is NOT the A2A
 * specification's `Task` / `Message` / `Part` / `Artifact` schema, and is expected to be replaced
 * for Hermes interop. That is exactly why the behaviour lives here and `A2AServer` is a thin
 * adapter over it: swapping the wire layer must not put the lifecycle, or its tests, at risk.
 */

import { collectAgentRun, NO_RUNNER_REASON, type AgentRunner } from "../agent-runner/index.js";

/** The A2A task lifecycle. `canceled` keeps the protocol's own spelling. */
export type A2ATaskState = "submitted" | "working" | "input-required" | "completed" | "failed" | "canceled";

export interface A2ATextPart {
  readonly type: "text";
  readonly text: string;
}

export interface A2AArtifact {
  readonly name: string;
  readonly parts: readonly A2ATextPart[];
}

export interface A2ATaskStatus {
  readonly state: A2ATaskState;
  readonly timestamp: string;
}

export interface A2ATask {
  readonly id: string;
  readonly agent: string;
  readonly taskType: string;
  /** The text the run was actually given, so a caller can see what its delegation became. */
  readonly objective: string;
  readonly status: A2ATaskStatus;
  /** Every state this task passed through, oldest first. */
  readonly history: readonly A2ATaskStatus[];
  readonly artifacts: readonly A2AArtifact[];
  readonly runId?: string;
  /** Present only when the task did not complete: the run's own reason, never a template. */
  readonly error?: string;
}

/** What the lifecycle needs of a request, whatever wire shape carried it. */
export interface A2ATaskRequest {
  readonly id: string;
  readonly agent: string;
  readonly taskType: string;
  readonly objective: string;
}

/**
 * Either the task, or a refusal. A refusal is NOT a task in a failed state: nothing ran, so there
 * is nothing to poll. `A2AServer` maps it to HTTP 503; another transport maps it its own way.
 */
export type A2ATaskOutcome = { readonly ok: true; readonly task: A2ATask } | { readonly ok: false; readonly reason: string };

/** The artifact name a completed task's output is stored under. */
export const A2A_RESULT_ARTIFACT = "result";

/** Orchestrator outcome -> A2A wire state. `cancelled` is the bus's spelling, `canceled` is A2A's. */
const WIRE_STATE: Record<"completed" | "failed" | "input-required" | "cancelled", A2ATaskState> = {
  completed: "completed",
  failed: "failed",
  "input-required": "input-required",
  cancelled: "canceled",
};

export interface A2ATaskEngineDeps {
  /** The agent runtime a task runs on. Absent, every submission is refused. */
  readonly runner?: AgentRunner;
  /** Injected so a test can pin the transition timestamps. Defaults to the wall clock. */
  readonly now?: () => string;
}

/**
 * Owns the task records and drives each one to a terminal state. `submit` resolves once the run
 * has settled, which is the A2A blocking send: the delegating agent gets the terminal task back.
 * Nothing is left running in the background, so a server can stop without orphaning a run.
 */
export class A2ATaskEngine {
  private runner: AgentRunner | undefined;
  private now: () => string;
  private tasks = new Map<string, A2ATask>();

  constructor(deps: A2ATaskEngineDeps = {}) {
    this.runner = deps.runner;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  /** True when a submitted task will reach a real agent runtime. */
  hasRunner(): boolean {
    return this.runner !== undefined;
  }

  /** The stored record for a task id, or undefined. */
  get(id: string): A2ATask | undefined {
    return this.tasks.get(id);
  }

  async submit(request: A2ATaskRequest, signal?: AbortSignal): Promise<A2ATaskOutcome> {
    const runner = this.runner;
    if (runner === undefined) {
      // No runtime, so no answer exists. Reporting a completed task here is the defect this
      // module was written to remove; nothing is stored, because nothing ran.
      return { ok: false, reason: NO_RUNNER_REASON };
    }

    let task = this.record(this.create(request));
    task = this.record({ ...task, ...this.transition(task, "working") });

    const outcome = await collectAgentRun(runner, {
      objective: request.objective,
      ...(signal === undefined ? {} : { signal }),
    });
    const state = WIRE_STATE[outcome.status];
    const settled: A2ATask = {
      ...task,
      ...this.transition(task, state),
      ...(outcome.runId === undefined ? {} : { runId: outcome.runId }),
      artifacts:
        state === "completed" && outcome.output !== ""
          ? [{ name: A2A_RESULT_ARTIFACT, parts: [{ type: "text", text: outcome.output }] }]
          : [],
      ...(state === "completed" ? {} : { error: outcome.output }),
    };
    return { ok: true, task: this.record(settled) };
  }

  private create(request: A2ATaskRequest): A2ATask {
    const status: A2ATaskStatus = { state: "submitted", timestamp: this.now() };
    return {
      id: request.id,
      agent: request.agent,
      taskType: request.taskType,
      objective: request.objective,
      status,
      history: [status],
      artifacts: [],
    };
  }

  /** The status and history a transition to `state` produces. History is append-only. */
  private transition(task: A2ATask, state: A2ATaskState): Pick<A2ATask, "status" | "history"> {
    const status: A2ATaskStatus = { state, timestamp: this.now() };
    return { status, history: [...task.history, status] };
  }

  private record(task: A2ATask): A2ATask {
    this.tasks.set(task.id, task);
    return task;
  }
}
