/**
 * `agent/chat`, with NO transport in it.
 *
 * It used to answer every editor request with a template string built from the prompt — no model,
 * no orchestrator, the defect AGENTS.md invariant 2 exists to prevent. One editor request is now
 * one real orchestration run, and the answer is THAT run's output. With no runtime attached it
 * refuses; it never answers on the runtime's behalf.
 *
 * `ACPServer` is a thin JSON-RPC-over-HTTP adapter over this. The real ACP is stdio JSON-RPC and
 * this server speaks HTTP, so the wire layer is expected to be replaced — which is the reason the
 * behaviour and its tests live here rather than inside the request handler.
 */

import { collectAgentRun, NO_RUNNER_REASON, type AgentRunner } from "../agent-runner/index.js";

/**
 * JSON-RPC implementation-defined server errors (the -32000..-32099 range the spec reserves for
 * exactly this). -32600..-32603 and -32700 keep their standard meanings; -32602 is invalid params.
 */
export const ACP_INVALID_PARAMS = -32602;
export const ACP_RUNNER_UNAVAILABLE = -32003;
export const ACP_RUN_FAILED = -32004;

export const ACP_PROMPT_REQUIRED = "agent/chat requires a non-empty `prompt` to run";

/** What a completed run hands back: the run's own text, and where it came from. */
export interface ACPChatResult {
  readonly agent: string;
  readonly runId: string | undefined;
  readonly status: "completed";
  readonly response: string;
}

export interface ACPChatRefusal {
  readonly code: number;
  readonly message: string;
  readonly data?: Record<string, unknown>;
}

export type ACPChatOutcome =
  | { readonly ok: true; readonly result: ACPChatResult }
  | { readonly ok: false; readonly error: ACPChatRefusal };

export interface ACPChatParams {
  readonly agent?: string;
  readonly prompt?: string;
}

/**
 * One editor request is one real run. The prompt IS the objective, unchanged; nothing here
 * composes text. Anything but a completed run is a refusal carrying the run's own reason, because
 * an editor showing an invented answer is worse than an editor showing a failure.
 */
export async function runAgentChat(
  runner: AgentRunner | undefined,
  params: ACPChatParams | undefined,
  signal?: AbortSignal,
): Promise<ACPChatOutcome> {
  const agent = params?.agent || "engineer";
  const objective = typeof params?.prompt === "string" ? params.prompt.trim() : "";
  if (objective === "") {
    return { ok: false, error: { code: ACP_INVALID_PARAMS, message: ACP_PROMPT_REQUIRED } };
  }
  if (runner === undefined) {
    return { ok: false, error: { code: ACP_RUNNER_UNAVAILABLE, message: NO_RUNNER_REASON } };
  }

  const outcome = await collectAgentRun(runner, { objective, ...(signal === undefined ? {} : { signal }) });
  if (outcome.status !== "completed") {
    return {
      ok: false,
      error: {
        code: ACP_RUN_FAILED,
        message: outcome.output,
        data: { runId: outcome.runId, status: outcome.status },
      },
    };
  }
  return { ok: true, result: { agent, runId: outcome.runId, status: "completed", response: outcome.output } };
}
