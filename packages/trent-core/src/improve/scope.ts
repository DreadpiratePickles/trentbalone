/**
 * Item 7 of the loop — fleet scope. Nine seats improve on every session; a specialist only while
 * installed and only once it has produced enough traces to clear the distill threshold. Never
 * spend a model call evolving a prompt for an agent nobody runs.
 */

import { CORE_SEATS, SEAT_ROLES } from "./trace-writer.js";

/** Default number of traces a specialist needs before its first sweep. */
export const DEFAULT_DISTILL_THRESHOLD = 3;

export interface SkippedSpecialist {
  agentId: string;
  reason: "below_threshold";
  traces: number;
  threshold: number;
}

export interface SweepScope {
  /** Agents to sweep, seats first in canonical order, then installed specialists in install order. */
  agents: string[];
  skipped: SkippedSpecialist[];
}

export interface ResolveScopeInput {
  readonly installedAgents: readonly string[];
  readonly traceCounts: Readonly<Record<string, number>>;
  readonly threshold?: number;
  /** `--agent`: restrict to one id (a seat or an installed specialist). */
  readonly agentFilter?: string;
}

export function resolveSweepScope(input: ResolveScopeInput): SweepScope {
  const threshold = input.threshold ?? DEFAULT_DISTILL_THRESHOLD;
  const agents: string[] = [...CORE_SEATS];
  const skipped: SkippedSpecialist[] = [];
  for (const agentId of input.installedAgents) {
    if (SEAT_ROLES.includes(agentId) || agents.includes(agentId)) continue;
    const traces = input.traceCounts[agentId] ?? 0;
    if (traces >= threshold) agents.push(agentId);
    else skipped.push({ agentId, reason: "below_threshold", traces, threshold });
  }
  if (input.agentFilter === undefined) return { agents, skipped };
  return {
    agents: agents.filter((id) => id === input.agentFilter),
    skipped: skipped.filter((s) => s.agentId === input.agentFilter),
  };
}
