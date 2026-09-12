import { EventEmitter } from "node:events";
import type { JobRun, JobRunStatus } from "@/lib/types";

export type JobRunEvent = {
  jobRunId: string;
  companyId?: string;
  status: JobRunStatus | "queued" | "started" | "step";
  summary: string;
  at: string;
  jobRun?: JobRun;
  /** Present when status === "step" */
  step?: {
    phase:
      | "agent_start"
      | "agent_end"
      | "plan_start"
      | "plan_end"
      | "approval_required"
      | "agent_retry"
      | "escalated"
      | "delegated"
      | "delegation_skipped";
    role?: string;
    label: string;
    tokens?: number;
    costCents?: number;
  };
};

declare global {
  // eslint-disable-next-line no-var
  var __trentJobEvents: EventEmitter | undefined;
}

function emitter() {
  if (!globalThis.__trentJobEvents) {
    globalThis.__trentJobEvents = new EventEmitter();
    globalThis.__trentJobEvents.setMaxListeners(100);
  }
  return globalThis.__trentJobEvents;
}

export function emitJobEvent(event: JobRunEvent) {
  emitter().emit("job", event);
}

export function subscribeJobEvents(onEvent: (event: JobRunEvent) => void) {
  const bus = emitter();
  bus.on("job", onEvent);
  return () => bus.off("job", onEvent);
}
