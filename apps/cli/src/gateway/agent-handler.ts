/**
 * The gateway's agent handler: an inbound chat message that passed the pairing gate becomes one
 * orchestrated run on the headless runtime, and the reply is that run's own consolidated summary.
 *
 * Nothing here composes text. The summary comes off the event stream (`consolidate_end` and
 * `run_done` carry `run.summary`; the wrapper's consolidator stamps the real brief on both), a
 * failed run replies with the reason the `run_failed` frame carries, and a stream that ends with
 * neither is silence — the manager sends nothing for `null`. Approval gates on the run are not
 * handled here: the approval link rides on the runtime's bus hooks and sees every run.
 */

import type { AgentHandler } from "@trent/core/gateway/index.js";
import type { OrcEvent } from "@trent/core/orchestrator/index.js";
import type { HeadlessRuntime } from "../runtime/headless.js";

/** What the handler needs of the runtime: one run per message. */
export type AgentRuntime = Pick<HeadlessRuntime, "run">;

/** The reply a finished stream produces, folded one event at a time. */
export function replyFromEvent(current: string | null, event: OrcEvent): string | null {
  switch (event.kind) {
    case "consolidate_end":
    case "run_done": {
      const summary = event.run?.summary;
      return summary !== undefined && summary !== "" ? summary : current;
    }
    case "run_failed": {
      if (event.detail !== undefined && event.detail !== "") return `Run failed: ${event.detail}`;
      const summary = event.run?.summary;
      return summary !== undefined && summary !== "" ? summary : current;
    }
    default:
      return current;
  }
}

export function createAgentHandler(runtime: AgentRuntime): AgentHandler {
  return async (_agentId, message) => {
    let reply: string | null = null;
    for await (const event of runtime.run(message.content, { trigger: "manual" })) reply = replyFromEvent(reply, event);
    return reply;
  };
}
