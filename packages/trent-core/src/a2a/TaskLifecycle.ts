/**
 * The A2A task lifecycle, with NO transport in it.
 *
 * A task is one real run on the injected {@link AgentRunner}. It is created `submitted`, moves to
 * `working` when the run starts, and settles `completed`, `failed`, `input-required` or `canceled`
 * according to what the run's event stream actually reported. Nothing here composes an answer: the
 * artifact text is the run's own summary and the `input-required` message is the approval gate's
 * own question (AGENTS.md invariant 2).
 *
 * The records are the specification's `Task` objects (see `./spec.ts`), so the JSON-RPC layer is a
 * dispatcher and nothing more. Trent's own vocabulary lives in `metadata`, which is what the
 * specification reserves it for.
 *
 * Source: https://a2a-protocol.org/latest/specification/
 */

import { randomUUID } from "node:crypto";
import { createAgentRunFold, NO_RUNNER_REASON, type AgentRunOutcome, type AgentRunner } from "../agent-runner/index.js";
import {
  a2aAgentMessage,
  a2aMessageText,
  A2A_ERROR_CONTENT_TYPE_NOT_SUPPORTED,
  A2A_ERROR_NO_RUNTIME,
  A2A_ERROR_TASK_NOT_CANCELABLE,
  A2A_ERROR_TASK_NOT_FOUND,
  A2A_ERROR_UNSUPPORTED_OPERATION,
  A2A_TERMINAL_STATES,
  JSONRPC_INVALID_PARAMS,
  type A2AArtifact,
  type A2AJsonRpcError,
  type A2AMessage,
  type A2AMessageSendParams,
  type A2AStreamEvent,
  type A2ATask,
  type A2ATaskState,
  type A2ATaskStatus,
} from "./spec.js";

/** The artifact name a task's output is stored under. */
export const A2A_RESULT_ARTIFACT = "result";

/** Orchestrator outcome -> A2A wire state. `cancelled` is the bus's spelling, `canceled` is A2A's. */
const WIRE_STATE: Record<AgentRunOutcome["status"], A2ATaskState> = {
  completed: "completed",
  failed: "failed",
  "input-required": "input-required",
  cancelled: "canceled",
};

export const A2A_MESSAGE_REQUIRED = "message/send requires a `message` with at least one non-empty text part";
export const A2A_TEXT_PARTS_ONLY = "this agent accepts text parts only";

/** Either a task, or the JSON-RPC error the caller gets instead. */
export type A2ATaskOutcome = { readonly ok: true; readonly task: A2ATask } | { readonly ok: false; readonly error: A2AJsonRpcError };

export interface A2ATaskEngineDeps {
  /** The agent runtime a task runs on. Absent, every submission is refused. */
  readonly runner?: AgentRunner;
  /** Injected so a test can pin transition timestamps. Defaults to the wall clock. */
  readonly now?: () => string;
  /** Injected so a test can pin task, context, message and artifact ids. Defaults to a UUID. */
  readonly newId?: (kind: string) => string;
}

/** What the engine keeps per task. The public `A2ATask` is derived from it. */
interface TaskRecord {
  readonly id: string;
  readonly contextId: string;
  status: A2ATaskStatus;
  history: A2AMessage[];
  artifacts: A2AArtifact[];
  metadata: Record<string, unknown>;
  /** Every state this task passed through, oldest first. Not part of the spec `Task`. */
  states: A2ATaskStatus[];
  controller: AbortController | undefined;
  /** Set by `cancel`, so the settling run cannot overwrite the caller's cancellation. */
  cancelled: boolean;
}

/**
 * Owns the task records and drives each one to a terminal state.
 *
 * `begin` validates and creates or continues the record without running anything, so a transport
 * can answer a bad request before it opens a stream. `run` and `stream` then drive the same task
 * the same way; the streaming path folds the identical event stream, so the two cannot disagree.
 */
export class A2ATaskEngine {
  private runner: AgentRunner | undefined;
  private now: () => string;
  private newId: (kind: string) => string;
  private tasks = new Map<string, TaskRecord>();

  constructor(deps: A2ATaskEngineDeps = {}) {
    this.runner = deps.runner;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.newId = deps.newId ?? ((kind: string) => `${kind}-${randomUUID()}`);
  }

  /** True when a submitted task will reach a real agent runtime. */
  hasRunner(): boolean {
    return this.runner !== undefined;
  }

  /** The stored task, trimmed to the last `historyLength` messages when asked (spec §7.3). */
  get(id: string, historyLength?: number): A2ATask | undefined {
    const record = this.tasks.get(id);
    return record === undefined ? undefined : toTask(record, historyLength);
  }

  /** Every state a task passed through. The pre-spec transport reported this; the spec does not. */
  states(id: string): readonly A2ATaskStatus[] {
    return this.tasks.get(id)?.states ?? [];
  }

  /**
   * Validate the request and create or continue the task, without running it.
   *
   * `metadata` is stored on the task untouched, which is where a caller's own routing information
   * (the pre-spec transport's seat and task type) lives.
   */
  begin(
    params: A2AMessageSendParams | undefined,
    metadata: Record<string, unknown> = {},
    options: { readonly adoptTaskId?: boolean } = {},
  ): A2ATaskOutcome {
    if (this.runner === undefined) return { ok: false, error: { code: A2A_ERROR_NO_RUNTIME, message: NO_RUNNER_REASON } };

    const message = params?.message;
    if (message === undefined || !Array.isArray(message.parts)) {
      return { ok: false, error: { code: JSONRPC_INVALID_PARAMS, message: A2A_MESSAGE_REQUIRED } };
    }
    if (message.parts.some((part) => part?.kind !== "text")) {
      return { ok: false, error: { code: A2A_ERROR_CONTENT_TYPE_NOT_SUPPORTED, message: A2A_TEXT_PARTS_ONLY } };
    }
    if (a2aMessageText(message) === "") {
      return { ok: false, error: { code: JSONRPC_INVALID_PARAMS, message: A2A_MESSAGE_REQUIRED } };
    }

    const existing = message.taskId === undefined ? undefined : this.tasks.get(message.taskId);
    // A spec client may name only a task it already has. The pre-spec transport let the CALLER
    // choose the id, so that path — and only that path — may adopt an id it has not seen.
    if (message.taskId !== undefined && existing === undefined && options.adoptTaskId !== true) {
      return { ok: false, error: { code: A2A_ERROR_TASK_NOT_FOUND, message: `no task with id "${message.taskId}" exists here` } };
    }
    if (existing !== undefined && A2A_TERMINAL_STATES.has(existing.status.state)) {
      return {
        ok: false,
        error: { code: A2A_ERROR_UNSUPPORTED_OPERATION, message: `task "${existing.id}" is ${existing.status.state} and takes no further messages` },
      };
    }

    const record = existing ?? this.create(message, metadata);
    record.history.push(normalise(message, record.id, record.contextId, this.newId("msg")));
    record.metadata = { ...record.metadata, ...metadata };
    record.cancelled = false;
    // A brand-new record was created `submitted`; a continued one returns to it.
    if (existing !== undefined) this.transition(record, "submitted");
    return { ok: true, task: toTask(record) };
  }

  /** Drive a task begun by {@link begin} to its terminal state, blocking until it settles. */
  async run(id: string, signal?: AbortSignal): Promise<A2ATaskOutcome> {
    const record = this.tasks.get(id);
    if (record === undefined) return { ok: false, error: { code: A2A_ERROR_TASK_NOT_FOUND, message: `no task with id "${id}" exists here` } };
    for await (const _event of this.stream(id, signal)) {
      // The blocking form is the streaming form with the frames thrown away: one code path.
    }
    return { ok: true, task: toTask(record) };
  }

  /**
   * The same run, as the specification's streaming events (spec §7.2).
   *
   * A step's own output becomes a `working` status update carrying that text, the run's summary
   * becomes the task artifact, and the last frame is the terminal status update with `final: true`.
   */
  async *stream(id: string, signal?: AbortSignal): AsyncGenerator<A2AStreamEvent> {
    const record = this.tasks.get(id);
    const runner = this.runner;
    if (record === undefined || runner === undefined) return;

    const controller = new AbortController();
    record.controller = controller;
    if (signal !== undefined) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    const objective = a2aMessageText(record.history.at(-1));
    yield this.statusEvent(record, "working", undefined, false);

    const fold = createAgentRunFold();
    let outcome: AgentRunOutcome;
    try {
      for await (const event of runner.run({ objective, signal: controller.signal })) {
        const progress = fold.apply(event);
        if (progress !== undefined) yield this.statusEvent(record, "working", progress, false);
      }
      outcome = fold.outcome();
    } catch (error) {
      outcome = fold.fail(error);
    } finally {
      record.controller = undefined;
    }

    const state = record.cancelled ? "canceled" : WIRE_STATE[outcome.status];
    if (outcome.runId !== undefined) record.metadata = { ...record.metadata, runId: outcome.runId };

    if (state === "completed" && outcome.output !== "") {
      const artifact: A2AArtifact = {
        artifactId: this.newId("artifact"),
        name: A2A_RESULT_ARTIFACT,
        parts: [{ kind: "text", text: outcome.output }],
      };
      record.artifacts = [artifact];
      yield { kind: "artifact-update", taskId: record.id, contextId: record.contextId, artifact, append: false, lastChunk: true };
    }

    // An unfinished run says why in its status message: the gate's own question when it parked on
    // an approval, the failure's own reason when it failed. Never a sentence written here.
    const reason = state === "input-required" ? (outcome.question ?? outcome.output) : state === "completed" ? undefined : outcome.output;
    yield this.statusEvent(record, state, reason === "" ? undefined : reason, true);
  }

  /** Spec §7.4 `tasks/cancel`: stop the run through its own AbortSignal and settle the task. */
  cancel(id: string): A2ATaskOutcome {
    const record = this.tasks.get(id);
    if (record === undefined) return { ok: false, error: { code: A2A_ERROR_TASK_NOT_FOUND, message: `no task with id "${id}" exists here` } };
    if (A2A_TERMINAL_STATES.has(record.status.state)) {
      return { ok: false, error: { code: A2A_ERROR_TASK_NOT_CANCELABLE, message: `task "${id}" is ${record.status.state}` } };
    }
    record.cancelled = true;
    record.controller?.abort();
    this.transition(record, "canceled");
    return { ok: true, task: toTask(record) };
  }

  private create(message: A2AMessage, metadata: Record<string, unknown>): TaskRecord {
    const id = message.taskId ?? this.newId("task");
    const status: A2ATaskStatus = { state: "submitted", timestamp: this.now() };
    const record: TaskRecord = {
      id,
      contextId: message.contextId ?? this.newId("ctx"),
      status,
      history: [],
      artifacts: [],
      metadata: { ...metadata },
      states: [status],
      controller: undefined,
      cancelled: false,
    };
    this.tasks.set(id, record);
    return record;
  }

  /** Records a transition. History is append-only, so a caller can see the whole path. */
  private transition(record: TaskRecord, state: A2ATaskState, message?: A2AMessage): A2ATaskStatus {
    const status: A2ATaskStatus = { state, timestamp: this.now(), ...(message === undefined ? {} : { message }) };
    record.status = status;
    record.states = [...record.states, status];
    return status;
  }

  private statusEvent(record: TaskRecord, state: A2ATaskState, text: string | undefined, final: boolean): A2AStreamEvent {
    const message = text === undefined ? undefined : a2aAgentMessage(this.newId("msg"), record.id, record.contextId, text);
    const status = this.transition(record, state, message);
    return { kind: "status-update", taskId: record.id, contextId: record.contextId, status, final };
  }
}

/** The spec `Task` a record describes. `historyLength` trims to the most recent messages. */
function toTask(record: TaskRecord, historyLength?: number): A2ATask {
  const history =
    historyLength === undefined || historyLength < 0 ? record.history : record.history.slice(Math.max(0, record.history.length - historyLength));
  return {
    kind: "task",
    id: record.id,
    contextId: record.contextId,
    status: record.status,
    history: [...history],
    artifacts: [...record.artifacts],
    metadata: { ...record.metadata },
  };
}

/** The caller's message, bound to the task it joined. Its text and id are left exactly as sent. */
function normalise(message: A2AMessage, taskId: string, contextId: string, fallbackId: string): A2AMessage {
  return {
    ...message,
    kind: "message",
    role: message.role === "agent" ? "agent" : "user",
    messageId: message.messageId !== undefined && message.messageId !== "" ? message.messageId : fallbackId,
    taskId,
    contextId,
  };
}
