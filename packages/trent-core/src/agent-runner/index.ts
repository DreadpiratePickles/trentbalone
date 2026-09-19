/**
 * The agent-runtime port the protocol servers (ACP, A2A) run on.
 *
 * Neither server may compose an answer of its own: a protocol request is one real orchestration
 * run, and the reply is that run's own output (AGENTS.md invariant 2). The servers live in
 * `packages/trent-core`, which must not import the CLI, so the runtime arrives as this port and
 * the CLI supplies it from `createHeadlessRuntime(...).run` at the point the server is built.
 *
 * A server constructed WITHOUT a runner has no way to answer, and says so — it never fabricates a
 * success. That is the whole reason this file exists.
 *
 * The fold in `collectAgentRun` is the same one the messaging gateway already uses
 * (`apps/cli/src/gateway/agent-handler.ts`, `replyFromEvent`): the summary comes off
 * `consolidate_end` / `run_done`, a failure off `run_failed`, and nothing is invented in between.
 */

import type { OrcEvent } from "../orchestrator/types.js";

/** One request for work. `objective` is the caller's own text, never a template. */
export interface AgentRunInput {
  readonly objective: string;
  /** Aborting stops the drain loop cooperatively; the server aborts in-flight runs on `stop()`. */
  readonly signal?: AbortSignal;
}

/** What a surface needs of the agent runtime: one run, streamed as orchestrator events. */
export interface AgentRunner {
  run(input: AgentRunInput): AsyncIterable<OrcEvent>;
}

/**
 * How a run ended, as the event stream reported it. `cancelled` keeps the orchestrator's own
 * spelling; the A2A wire state is `canceled`, and `A2AServer` maps between the two.
 */
export type AgentRunStatus = "completed" | "failed" | "input-required" | "cancelled";

export interface AgentRunOutcome {
  readonly status: AgentRunStatus;
  /** The run's own summary, or the reason it failed. Empty only when the run produced neither. */
  readonly output: string;
  readonly runId: string | undefined;
  /** How many frames the stream carried. Zero means the runtime produced nothing at all. */
  readonly events: number;
  /**
   * The question the run parked on, when it parked on an approval gate. It is the gate's own text
   * (`detail`, else the step title), so a protocol that has somewhere to put a question — A2A's
   * `input-required` status message — can hand the caller the real one instead of a placeholder.
   */
  readonly question?: string;
}

/** Returned by a server that was built with no runner. HTTP 503 / JSON-RPC error, never a result. */
export const NO_RUNNER_REASON =
  "this server was started without an agent runtime, so it cannot run the request";

/** A stream that ended on an approval gate: real state, but no answer to hand back yet. */
export const AWAITING_APPROVAL_REASON =
  "the run stopped on an approval gate and no decision reached this server";

/** A stream that ended without run_done, run_failed or run_cancelled. */
export const NO_TERMINAL_FRAME_REASON =
  "the run ended without a terminal frame, so it produced no result";

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message !== "") return error.message;
  const text = String(error);
  return text === "" ? NO_TERMINAL_FRAME_REASON : text;
}

/**
 * The fold, one event at a time.
 *
 * `collectAgentRun` drives a run to its end; a streaming transport (A2A `message/stream`) has to
 * emit a frame per event AND still end with the same outcome, so the fold is separated from the
 * loop rather than written twice. Both paths therefore agree by construction.
 */
export interface AgentRunFold {
  /** Feed one frame. Returns the text this frame added to the run's output, if any. */
  apply(event: OrcEvent): string | undefined;
  /** The outcome as the frames seen so far describe it. */
  outcome(): AgentRunOutcome;
  /** Record a throw from the runtime as a failed run carrying the real message. */
  fail(error: unknown): AgentRunOutcome;
}

export function createAgentRunFold(): AgentRunFold {
  let runId: string | undefined;
  let output = "";
  let status: AgentRunStatus | undefined;
  let question: string | undefined;
  let gated = false;
  let events = 0;

  const settle = (): AgentRunOutcome => {
    const base = { runId, events, ...(question === undefined ? {} : { question }) };
    if (status !== undefined) return { status, output, ...base };
    // No terminal frame. An open approval gate is real state and gets its own A2A state; anything
    // else is a run that simply produced nothing, which is a failure and is reported as one.
    if (gated) return { status: "input-required", output: output === "" ? AWAITING_APPROVAL_REASON : output, ...base };
    return { status: "failed", output: output === "" ? NO_TERMINAL_FRAME_REASON : output, ...base };
  };

  return {
    apply(event: OrcEvent): string | undefined {
      events += 1;
      if (runId === undefined && typeof event.runId === "string" && event.runId !== "") runId = event.runId;

      switch (event.kind) {
        case "step_output": {
          const text = event.step?.output;
          return text !== undefined && text !== "" ? text : undefined;
        }
        case "consolidate_end":
        case "run_done": {
          const summary = event.run?.summary;
          if (summary !== undefined && summary !== "") output = summary;
          if (event.kind === "run_done") status = "completed";
          // The summary is the run's RESULT, not progress: it leaves as the task artifact, so it
          // is deliberately not reported here as another chunk of intermediate text.
          return undefined;
        }
        case "run_failed": {
          const detail = event.detail;
          const summary = event.run?.summary;
          if (detail !== undefined && detail !== "") output = detail;
          else if (summary !== undefined && summary !== "") output = summary;
          status = "failed";
          return undefined;
        }
        case "run_cancelled":
          status = "cancelled";
          return undefined;
        case "run_awaiting_approval":
        case "step_awaiting_approval": {
          gated = true;
          const asked = event.detail !== undefined && event.detail !== "" ? event.detail : event.step?.title;
          if (question === undefined && asked !== undefined && asked !== "") question = asked;
          return undefined;
        }
        default:
          return undefined;
      }
    },
    outcome: settle,
    fail(error: unknown): AgentRunOutcome {
      return { status: "failed", output: messageOf(error), runId, events, ...(question === undefined ? {} : { question }) };
    },
  };
}

/**
 * Drives one run to its end and folds the event stream into an outcome.
 *
 * A throw from the runtime is a failed run carrying the real message, not an exception the HTTP
 * layer has to invent a body for.
 */
export async function collectAgentRun(runner: AgentRunner, input: AgentRunInput): Promise<AgentRunOutcome> {
  const fold = createAgentRunFold();
  try {
    for await (const event of runner.run(input)) fold.apply(event);
  } catch (error) {
    return fold.fail(error);
  }
  return fold.outcome();
}
