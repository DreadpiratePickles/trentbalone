/**
 * [S2] Solo runs on the audit chain (council B4).
 *
 * The fleet's run rows are the app's `auditTransition` (`apps/web/lib/orchestrator-runtime.ts`):
 * `store.addAudit(companyId, actor, "orchestration.<transition>", "orchestration", runId, summary)`,
 * actor `agent`, `system` for a failure, through the app store the rest of the app writes its chain
 * to. A solo run writes the same rows through the same call, so `trent audit` walks one chain
 * whichever runner a turn ran on:
 *
 *   run_start               orchestration.run_start      "Started: <objective>"
 *   step_start              orchestration.step_start     "trent: <title>"
 *   step_awaiting_approval  orchestration.step_start     "Awaiting tool approval: <held call>"
 *   a decision (router)     orchestration.step_approved / step_rejected
 *   run_done / run_failed / run_cancelled               the run's own summary or reason
 *
 * `run_awaiting_approval` is the same gate as its step frame and writes nothing. A decision is
 * written where it is made (the router's `onDecision`), because a rejection has no frame of its own.
 * Writes are queued in frame order and never fail a run: like the fleet's `.catch(() => {})`, a
 * failed write is dropped, but here it is also reported once.
 *
 * Where the rows land is the app store's decision: the app's database in connected mode, its
 * in-process store in standalone mode, exactly as for the fleet (docs/solo.md says so).
 */
import type { OrcEvent } from "../orchestrator/types.js";
import { clip } from "./events.js";
import type { SoloDecision } from "./router.js";

export interface SoloAuditRow {
  readonly companyId: string;
  readonly actor: "system" | "user" | "agent";
  readonly action: string;
  readonly objectType: string;
  readonly objectId: string;
  readonly summary: string;
}

export type SoloAuditWriter = (row: SoloAuditRow) => Promise<void>;

export interface SoloAuditSink {
  sink(event: OrcEvent): void;
  flush(): Promise<void>;
  /** The router's `onDecision`: a human's decision on a held call. */
  decision(runId: string, stepId: string, decision: SoloDecision): void;
}

export interface SoloAuditOptions {
  readonly companyId: string;
  /** Defaults to the app store's `addAudit`, imported on the first row, never before. */
  readonly write?: SoloAuditWriter;
  readonly onError?: (reason: string) => void;
}

type AppAuditStore = { store: { addAudit(companyId: string, actor: string, action: string, objectType: string, objectId: string, summary: string): Promise<unknown> } };

/** The app's own writer, loaded lazily: nothing in `apps/web` is imported until a row is written. */
function appWriter(): SoloAuditWriter {
  let loaded: Promise<AppAuditStore> | undefined;
  return async (row) => {
    loaded ??= import("@/lib/store") as unknown as Promise<AppAuditStore>;
    await (await loaded).store.addAudit(row.companyId, row.actor, row.action, row.objectType, row.objectId, row.summary);
  };
}

type Transition = "run_start" | "step_start" | "step_approved" | "step_rejected" | "run_done" | "run_failed" | "run_cancelled";

function rowFor(event: OrcEvent): { transition: Transition; summary: string } | undefined {
  switch (event.kind) {
    case "run_start":
      return { transition: "run_start", summary: `Started: ${clip(event.run?.objective ?? "", 300)}` };
    case "step_start":
      return { transition: "step_start", summary: `${event.step?.agentRole ?? "trent"}: ${event.step?.title ?? ""}` };
    case "step_awaiting_approval":
      return { transition: "step_start", summary: `Awaiting tool approval: ${event.step?.title ?? event.detail ?? ""}` };
    case "run_done":
      return { transition: "run_done", summary: `Completed: ${clip(event.run?.summary ?? "", 300)}` };
    case "run_failed":
      return { transition: "run_failed", summary: clip(event.detail ?? event.run?.summary ?? "the run failed", 300) };
    case "run_cancelled":
      return { transition: "run_cancelled", summary: clip(event.detail ?? "the run was cancelled", 300) };
    default:
      return undefined;
  }
}

const DECISION_ROW: Record<SoloDecision, { transition: Transition; verb: string }> = {
  approved: { transition: "step_approved", verb: "Approved" },
  answered: { transition: "step_approved", verb: "Answered" },
  rejected: { transition: "step_rejected", verb: "Rejected" },
};

export function createSoloAuditSink(options: SoloAuditOptions): SoloAuditSink {
  const write = options.write ?? appWriter();
  let queue: Promise<void> = Promise.resolve();
  let reported = false;

  const append = (transition: Transition, runId: string, summary: string): void => {
    const row: SoloAuditRow = {
      companyId: options.companyId,
      // The fleet's rule (`auditTransition`): a failure is the system's, every other transition the agent's.
      actor: transition === "run_failed" ? "system" : "agent",
      action: `orchestration.${transition}`,
      objectType: "orchestration",
      objectId: runId,
      summary,
    };
    queue = queue.then(
      () =>
        write(row).catch((error: unknown) => {
          if (reported) return;
          reported = true;
          options.onError?.(`the solo audit row could not be written: ${error instanceof Error ? error.message : String(error)}`);
        }),
    );
  };

  return {
    sink(event) {
      const row = rowFor(event);
      if (row !== undefined) append(row.transition, event.runId, row.summary);
    },
    flush: () => queue,
    decision(runId, stepId, decision) {
      const { transition, verb } = DECISION_ROW[decision];
      append(transition, runId, `${verb} solo step ${stepId}`);
    },
  };
}
