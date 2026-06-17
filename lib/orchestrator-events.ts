/**
 * Orchestrator event bus — in-process pub/sub for SSE consumers.
 *
 * Each orchestration run emits events as it transitions phases
 * (plan_start, plan_end, step_start, step_end, critic, summary, done).
 * The /api/companies/[id]/orchestrate/stream endpoint subscribes by runId
 * and pipes events to the browser via Server-Sent Events.
 */

import type { OrchestrationRun, StepRecord } from "@/lib/orchestrator";

export type OrcEventKind =
  | "run_preflight"
  | "run_start"
  | "plan_start"
  | "plan_end"
  | "step_pending"
  | "step_start"
  | "step_output"
  | "step_critic"
  | "step_note"
  | "step_end"
  | "step_blocked"
  | "step_awaiting_approval"
  | "step_approved"
  | "consolidate_start"
  | "consolidate_end"
  | "run_awaiting_approval"
  | "run_done"
  | "run_failed"
  | "run_cancelled"
  | "heartbeat";

export type OrcEvent = {
  kind: OrcEventKind;
  runId: string;
  at: string;
  step?: Partial<StepRecord>;
  run?: Partial<OrchestrationRun>;
  detail?: string;
};

type Listener = (event: OrcEvent) => void;

const globalBus = globalThis as unknown as { __trentOrcBus?: Map<string, Set<Listener>> };
const channels: Map<string, Set<Listener>> = globalBus.__trentOrcBus ?? new Map();
globalBus.__trentOrcBus = channels;

function key(runId: string): string {
  return `run:${runId}`;
}

export function emitOrcEvent(event: OrcEvent): void {
  const subs = channels.get(key(event.runId));
  if (!subs) return;
  for (const listener of subs) {
    try { listener(event); } catch (err) { console.error("orc-event listener_failed", err); }
  }
}

export function subscribeOrcEvents(runId: string, listener: Listener): () => void {
  const k = key(runId);
  let subs = channels.get(k);
  if (!subs) { subs = new Set(); channels.set(k, subs); }
  subs.add(listener);
  return () => {
    subs!.delete(listener);
    if (subs!.size === 0) channels.delete(k);
  };
}
