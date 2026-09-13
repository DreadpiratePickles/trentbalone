/**
 * Item 1 of the loop — write the traces.
 *
 * `deriveTraceRecord` had no production caller, so the AgentTrace table was never written and
 * every downstream stage (Foundry, health, GEPA) computed over zero rows. This hook sits on the
 * orchestrator wrapper's event bus, turns every `step_end` / `step_blocked` into one trace keyed by
 * (companyId, agentId, taskType) and appends it to the durable store.
 *
 * Scope follows residency (design doc section 12): the nine seats always trace; a specialist
 * plugged into a seat traces only while it is installed. Anything else is dropped here, before it
 * costs a row.
 */

import type { OrcEvent, TraceSink } from "../orchestrator/types.js";
import type { AgentTraceRow, ImproveStorePort } from "../store/StorePort.js";
import { deriveTrace, type OrchestratorStepLike } from "../traces/trace-store.js";

/** The nine resident seats (design doc section 12). */
export const CORE_SEATS = ["ceo", "engineer", "growth", "content", "support", "analyst", "finance", "browser", "escalation"] as const;

/** Every role the orchestrator can schedule a step under: the nine seats plus the app's `sales`. */
export const SEAT_ROLES: readonly string[] = [...CORE_SEATS, "sales"];

/** A hook on the run's event stream: a synchronous sink plus a flush the run awaits before it settles. */
export interface BusHook {
  readonly sink: TraceSink;
  flush(): Promise<void>;
}

export interface TraceWriterOptions {
  readonly store: ImproveStorePort;
  /** Specialist ids currently installed (`config.fleet.installed_agents`). Seats need no entry. */
  readonly installedAgents: readonly string[];
  /**
   * Maps a seat role to the agent that actually ran it: the plugged specialist's id, or the role
   * itself. Defaults to the role, which is what the standalone CLI has.
   */
  readonly resolveAgentId?: (companyId: string, role: string) => Promise<string> | string;
  readonly now?: () => string;
  /** Diagnostic channel for a failed write. Never receives a prompt body. */
  readonly onError?: (message: string) => void;
}

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "of", "to", "for", "in", "on", "with", "our", "my", "your", "this", "that",
  "is", "are", "be", "we", "it", "as", "at", "by", "from", "into", "then", "than", "please",
]);

/**
 * A stable grouping key for "tasks of this kind": the first four content words of the objective,
 * slugged. Deterministic, so the same objective across sessions lands in the same bucket.
 */
export function deriveTaskType(objective: string): string {
  const words = objective
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w))
    .slice(0, 4);
  return words.length === 0 ? "general" : words.join("-");
}

interface RunContext {
  companyId: string;
  objective: string;
}

export function isTraceableAgent(agentId: string, installedAgents: readonly string[]): boolean {
  return SEAT_ROLES.includes(agentId) || installedAgents.includes(agentId);
}

export function createTraceWriter(options: TraceWriterOptions): BusHook {
  const runs = new Map<string, RunContext>();
  const written = new Set<string>();
  const pending = new Set<Promise<void>>();
  const now = options.now ?? (() => new Date().toISOString());
  const resolveAgentId = options.resolveAgentId ?? ((_companyId: string, role: string) => role);

  async function write(event: OrcEvent, context: RunContext): Promise<void> {
    const step = event.step as (Partial<OrchestratorStepLike> & { id?: string }) | undefined;
    if (!step?.id || !step.agentRole || !step.title || !step.status) return;
    const agentId = await resolveAgentId(context.companyId, step.agentRole);
    if (!isTraceableAgent(agentId, options.installedAgents)) return;

    const record = deriveTrace(step as OrchestratorStepLike, {
      companyId: context.companyId,
      runId: event.runId,
      taskType: deriveTaskType(context.objective),
      now: now(),
    });
    // One trace per finished step: a step re-emitted after an approval or a retry is not two steps.
    if (written.has(record.id)) return;
    written.add(record.id);

    const row: AgentTraceRow = {
      id: record.id,
      companyId: record.companyId,
      agentRole: record.agentRole,
      agentId,
      runId: record.runId,
      taskType: record.taskType,
      stepTitle: record.stepTitle,
      status: record.status,
      toolCalls: record.toolCalls,
      toolCallCount: record.toolCallCount,
      critiqueVerdict: record.critiqueVerdict ?? null,
      improvement: record.improvement ?? null,
      evalScore: record.evalScore ?? null,
      costCents: Math.trunc(record.costCents),
      latencyMs: record.latencyMs ?? null,
      humanCorrected: record.humanCorrected,
      skillApplied: record.skillApplied ?? false,
      createdAt: record.createdAt,
    };
    await options.store.appendTrace(row);
  }

  const sink: TraceSink = (event) => {
    if (event.kind === "run_start") {
      const companyId = event.run?.companyId;
      if (companyId) runs.set(event.runId, { companyId, objective: event.run?.objective ?? "" });
      return;
    }
    if (event.kind !== "step_end" && event.kind !== "step_blocked") return;
    const context = runs.get(event.runId);
    if (!context) return;
    const task = write(event, context).catch((error: unknown) => {
      options.onError?.(`trace write failed for run ${event.runId}: ${error instanceof Error ? error.message : String(error)}`);
    });
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };

  return {
    sink,
    async flush() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
}
