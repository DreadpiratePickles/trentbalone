/**
 * The link between a parked orchestrator step and a chat approval.
 *
 * A `step_awaiting_approval` / `run_awaiting_approval` frame on a run's bus becomes one approval
 * row carrying the run and step ids, rendered as a card and sent to the configured owner. The
 * owner's decision on that row — a button, or an `APPROVE <id> <nonce>` reply — comes back through
 * the bridge's `approval_decided` event and releases the step with `approve`/`reject` on the
 * orchestrator. The bus emits both frames for one gate, so a gate is keyed by (runId, stepId) the
 * way the REPL engine keys it, and each key holds at most one pending card at a time.
 *
 * The link is a bus hook in the shape `improve/trace-writer.ts` uses: whoever iterates the run's
 * events hands each one to `sink`. With no owner configured nothing can be sent, so the link is
 * inert and says so once, in a structured log line.
 */

import { StructuredLogger } from "../telemetry/logger.js";
import type { OrcEvent, Orchestrator } from "../orchestrator/types.js";
import type { ApprovalBridge, ApprovalRequest } from "./ApprovalBridge.js";
import type { GatewayManager } from "./GatewayManager.js";

/** The two calls an approval decision needs; `Orchestrator` satisfies it, and so does a fake. */
export type ApprovalTarget = Pick<Orchestrator, "approve" | "reject">;

/** Who receives approval cards: `gateway.owner` in the profile config. */
export interface GatewayOwner {
  readonly platform: string;
  readonly channelId: string;
}

export interface RunApprovalLinkDeps {
  readonly orchestrator: ApprovalTarget;
  readonly bridge: ApprovalBridge;
  readonly manager: Pick<GatewayManager, "sendApproval">;
  readonly owner?: GatewayOwner;
  /** Where structured log lines go. Defaults to stderr. */
  readonly log?: (line: string) => void;
}

export interface RunApprovalLink {
  /** False when no owner is configured: `sink` then does nothing. */
  readonly active: boolean;
  /** Receives every event of every run; only the two gate kinds do anything. */
  sink(event: OrcEvent): void;
  /** Stops listening for decisions. Idempotent. */
  close(): void;
}

const GATE_KINDS: ReadonlySet<OrcEvent["kind"]> = new Set(["step_awaiting_approval", "run_awaiting_approval"]);

export function linkRunApprovals(deps: RunApprovalLinkDeps): RunApprovalLink {
  const logger = new StructuredLogger({ runId: "gateway", stage: "gateway.approval_link", sink: deps.log });
  const owner = deps.owner;
  if (owner === undefined) {
    logger.warn("gateway.approval_link.disabled", { reason: "gateway.owner is not configured; run approvals will not reach chat" });
    return { active: false, sink: () => undefined, close: () => undefined };
  }

  /** Pending card per gate key, so a decision releases the step it was asked for, once. */
  const pending = new Map<string, string>();
  const keyOf = (runId: string, stepId: string): string => `${runId}/${stepId}`;

  const onDecided = (row: ApprovalRequest): void => {
    if (row.runId === undefined || row.stepId === undefined) return;
    const key = keyOf(row.runId, row.stepId);
    if (pending.get(key) !== row.id) return;
    pending.delete(key);
    const release = row.status === "approved" ? deps.orchestrator.approve : deps.orchestrator.reject;
    void release
      .call(deps.orchestrator, row.runId, row.stepId)
      .then((released) => logger.info("gateway.approval_link.released", { runId: row.runId, stepId: row.stepId, decision: row.status, released }))
      .catch((error: unknown) =>
        logger.error("gateway.approval_link.release_failed", { runId: row.runId, stepId: row.stepId, reason: error instanceof Error ? error.message : String(error) }),
      );
  };
  deps.bridge.on("approval_decided", onDecided);
  let closed = false;

  return {
    active: true,
    sink(event) {
      if (closed || !GATE_KINDS.has(event.kind)) return;
      const stepId = event.step?.id;
      if (stepId === undefined) {
        logger.warn("gateway.approval_link.gate_without_step", { runId: event.runId, kind: event.kind });
        return;
      }
      const key = keyOf(event.runId, stepId);
      if (pending.has(key)) return;
      const request = deps.bridge.createApprovalRequest(
        event.step?.agentRole ?? "orchestrator",
        event.step?.title ?? event.detail ?? stepId,
        { runId: event.runId, stepId, reason: event.detail ?? null },
        { runId: event.runId, stepId },
      );
      pending.set(key, request.id);
      void deps.manager.sendApproval(request, owner.platform, owner.channelId).catch((error: unknown) =>
        logger.error("gateway.approval_link.send_failed", { runId: event.runId, stepId, reason: error instanceof Error ? error.message : String(error) }),
      );
    },
    close() {
      closed = true;
      deps.bridge.off("approval_decided", onDecided);
    },
  };
}
