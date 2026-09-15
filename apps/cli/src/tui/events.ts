/**
 * How one orchestrator event lands on the TUI's three panes.
 *
 * Pure: every effect goes through the sinks, so this is testable with a scripted event
 * stream and no terminal. Every line, cost and duration the panes show originates in an
 * event; nothing here invents a reply, a cost or a latency.
 */

import type { OrcEvent } from "@trent/core/orchestrator/index.js";
import type { AgentMessageMetadata } from "./hooks/useSession.js";
import type { TuiActivityItem } from "./types.js";

export const ORCHESTRATOR_ROLE = "orchestrator";

export interface EventSinks {
  /** Records one integer-cent cost; returns the alert line for each threshold it crossed. */
  recordCost(costCents: number): string[];
  appendAgentMessage(agent: string, text: string, metadata?: AgentMessageMetadata): void;
  pushActivity(item: Omit<TuiActivityItem, "id" | "timestamp">): void;
  openApproval(input: OrchestratorApprovalDetails & { agent: string; action: string }): void;
  /** The seat that speaks for the run as a whole, for the consolidated summary. */
  sessionAgent: string;
}

/** The orchestrator's own linkage, carried on the bridge request so a decision routes back. */
export interface OrchestratorApprovalDetails {
  runId: string;
  stepId: string;
  reason?: string;
}

/** Wall-clock time the orchestrator recorded for a step, when it recorded both ends. */
export function stepDurationMs(step: OrcEvent["step"]): number | undefined {
  if (step?.startedAt === undefined || step.completedAt === undefined) return undefined;
  const ms = Date.parse(step.completedAt) - Date.parse(step.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

export function handleOrcEvent(event: OrcEvent, sinks: EventSinks): void {
  const step = event.step;
  const role = step?.agentRole ?? ORCHESTRATOR_ROLE;
  switch (event.kind) {
    case "step_start":
      sinks.pushActivity({ agent: role, action: step?.title ?? "step" });
      return;
    case "step_end":
    case "consolidate_end": {
      const cost = step?.costCents;
      if (typeof cost === "number" && Number.isInteger(cost)) {
        for (const alert of sinks.recordCost(cost)) sinks.pushActivity({ agent: "budget", action: alert });
      }
      if (event.kind === "step_end") {
        const durationMs = stepDurationMs(step);
        sinks.pushActivity({ agent: role, action: step?.title ?? "step", costCents: cost, durationMs });
        const output = step?.output;
        if (output !== undefined && output !== "") {
          sinks.appendAgentMessage(role, output, { costCents: cost, durationMs });
        }
      }
      return;
    }
    case "step_blocked":
      sinks.pushActivity({ agent: role, action: `${step?.title ?? "step"} blocked` });
      return;
    case "step_awaiting_approval":
    case "run_awaiting_approval": {
      if (step?.id === undefined) return;
      sinks.openApproval({
        agent: role,
        action: step.title ?? "an action",
        runId: event.runId,
        stepId: step.id,
        reason: event.detail,
      });
      return;
    }
    case "run_done":
      if (event.run?.summary !== undefined && event.run.summary !== "") {
        sinks.appendAgentMessage(sinks.sessionAgent, event.run.summary);
      }
      return;
    case "run_failed":
      sinks.appendAgentMessage(ORCHESTRATOR_ROLE, `Run failed${event.detail ? `: ${event.detail}` : ""}`);
      return;
    case "run_cancelled":
      sinks.appendAgentMessage(ORCHESTRATOR_ROLE, "Run cancelled");
      return;
    default:
      return;
  }
}
