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
 * Drives one run to its end and folds the event stream into an outcome.
 *
 * A throw from the runtime is a failed run carrying the real message, not an exception the HTTP
 * layer has to invent a body for.
 */
export async function collectAgentRun(runner: AgentRunner, input: AgentRunInput): Promise<AgentRunOutcome> {
  let runId: string | undefined;
  let output = "";
  let status: AgentRunStatus | undefined;
  let gated = false;
  let events = 0;

  try {
    for await (const event of runner.run(input)) {
      events += 1;
      if (runId === undefined && typeof event.runId === "string" && event.runId !== "") runId = event.runId;

      switch (event.kind) {
        case "consolidate_end":
        case "run_done": {
          const summary = event.run?.summary;
          if (summary !== undefined && summary !== "") output = summary;
          if (event.kind === "run_done") status = "completed";
          break;
        }
        case "run_failed": {
          const detail = event.detail;
          const summary = event.run?.summary;
          if (detail !== undefined && detail !== "") output = detail;
          else if (summary !== undefined && summary !== "") output = summary;
          status = "failed";
          break;
        }
        case "run_cancelled":
          status = "cancelled";
          break;
        case "run_awaiting_approval":
        case "step_awaiting_approval":
          gated = true;
          break;
        default:
          break;
      }
    }
  } catch (error) {
    return { status: "failed", output: messageOf(error), runId, events };
  }

  if (status !== undefined) return { status, output, runId, events };
  // No terminal frame. An open approval gate is real state and gets its own A2A state; anything
  // else is a run that simply produced nothing, which is a failure and is reported as one.
  if (gated) return { status: "input-required", output: output === "" ? AWAITING_APPROVAL_REASON : output, runId, events };
  return { status: "failed", output: output === "" ? NO_TERMINAL_FRAME_REASON : output, runId, events };
}
