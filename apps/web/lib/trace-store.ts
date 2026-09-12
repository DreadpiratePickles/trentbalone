/**
 * Trace Store — Phase 0 of the Trent self-improvement loop.
 *
 * The orchestrator already produces rich per-step traces (reasoning, tool calls,
 * critique verdict, cost) in `StepRecord`, then discards them after a run. This
 * module persists a distilled, queryable `TraceRecord` keyed by company + task
 * type — the episodic substrate the Skill Foundry (Phase 2) and GEPA (Phase 4)
 * learn from.
 *
 * Deliberately dependency-light: type-only imports from the app, pure derivation
 * functions, and an in-memory repository that a Prisma-backed slice will later
 * implement against the same interface. No LLM calls, no I/O.
 *
 * See docs/superpowers/plans/2026-06-02-self-improvement-loop-plan.md
 */

import type { StepRecord, OrchestrationCritique } from "@/lib/orchestrator-runtime";
import type { AgentRole } from "@/lib/types";

export type TraceRecord = {
  id: string;
  companyId: string;
  runId: string;
  /** Stable grouping key for "tasks of this kind" — used by Foundry + GEPA. */
  taskType: string;
  agentRole: AgentRole;
  stepTitle: string;
  status: StepRecord["status"];
  toolCalls: string[];
  toolCallCount: number;
  critiqueVerdict?: OrchestrationCritique["verdict"];
  /** The critic's natural-language "improvement" note — GEPA's reflection signal. */
  improvement?: string;
  evalScore?: number;
  costCents: number;
  latencyMs?: number;
  /** True when a human approved/corrected this step (a strong learning signal). */
  humanCorrected: boolean;
  /**
   * True when a live distilled skill for this task type was injected into the
   * agent's context for this step (the OpenSpace "applied" signal). Optional on
   * the record (legacy/Prisma rows omit it); `deriveTraceRecord` always sets an
   * explicit boolean. Treated as "not applied" when absent — we never assume a
   * skill was applied when we don't know.
   */
  skillApplied?: boolean;
  createdAt: string;
};

export type DeriveTraceContext = {
  companyId: string;
  runId: string;
  taskType: string;
  evalScore?: number;
  /** Set when a human approval or correction was applied to this step. */
  humanCorrected?: boolean;
  /** Set when a live skill for this task type was injected for this step. */
  skillApplied?: boolean;
  /** Injectable for determinism in tests. */
  id?: string;
  now?: string;
};

function latencyMs(step: StepRecord): number | undefined {
  if (!step.startedAt || !step.completedAt) return undefined;
  const ms = new Date(step.completedAt).getTime() - new Date(step.startedAt).getTime();
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

/** Turn a completed orchestrator step into a persisted trace record. */
export function deriveTraceRecord(step: StepRecord, ctx: DeriveTraceContext): TraceRecord {
  // ToolCallRecord carries the tool name in `adapter` (e.g. "GitHub"). Older/test
  // shapes used `tool`/`name`. Read `adapter` first so trace tool names match the
  // tool-catalog names the router + tool-health cascade key on — otherwise every
  // call collapses to "unknown" and tool health is computed over nothing.
  const toolCalls = (step.toolCalls ?? []).map((tc) =>
    typeof tc === "string"
      ? tc
      : (tc as { adapter?: string; tool?: string; name?: string }).adapter
        ?? (tc as { tool?: string }).tool
        ?? (tc as { name?: string }).name
        ?? "unknown",
  );
  return {
    id: ctx.id ?? `trace_${ctx.runId}_${step.id}`,
    companyId: ctx.companyId,
    runId: ctx.runId,
    taskType: ctx.taskType,
    agentRole: step.agentRole,
    stepTitle: step.title,
    status: step.status,
    toolCalls,
    toolCallCount: toolCalls.length,
    critiqueVerdict: step.critique?.verdict,
    improvement: step.critique?.improvement,
    evalScore: ctx.evalScore,
    costCents: step.costCents ?? 0,
    latencyMs: latencyMs(step),
    humanCorrected: ctx.humanCorrected ?? false,
    skillApplied: ctx.skillApplied ?? false,
    createdAt: ctx.now ?? new Date().toISOString(),
  };
}

export type DistillTrigger =
  | "tool_call_threshold"
  | "error_recovery"
  | "high_score_no_skill"
  | "human_correction"
  /** OpenSpace-style metric monitor: a live skill's health has degraded. */
  | "skill_health";

export type DistillDecision = {
  shouldDistill: boolean;
  triggers: DistillTrigger[];
};

export type DistillOptions = {
  /** Hermes default: a run touching >= 5 tool calls is non-trivial. */
  toolCallThreshold?: number;
  /** Eval score (0..1) above which a novel task type is worth documenting. */
  highScore?: number;
  /** Task types that already have a skill — suppresses high_score_no_skill. */
  existingSkillTaskTypes?: ReadonlySet<string>;
  /**
   * Set by the metric monitor (lib/skill-health) when this task type's live
   * skill has degraded. Forces a distill pass even if no per-run trigger fired —
   * the resulting draft is a FIX of the rotting skill.
   */
  degradedHealth?: boolean;
};

/**
 * Hermes-style trigger check across the traces of a single run.
 * Returns which triggers fired and whether the run is worth distilling.
 */
export function shouldDistillSkill(
  traces: readonly TraceRecord[],
  options: DistillOptions = {},
): DistillDecision {
  const triggers = new Set<DistillTrigger>();
  if (traces.length === 0) return { shouldDistill: false, triggers: [] };

  const threshold = options.toolCallThreshold ?? 5;
  const highScore = options.highScore ?? 0.8;
  const existing = options.existingSkillTaskTypes ?? new Set<string>();

  const totalToolCalls = traces.reduce((sum, t) => sum + t.toolCallCount, 0);
  if (totalToolCalls >= threshold) triggers.add("tool_call_threshold");

  // error recovery: a step that was retried/escalated yet the run finished passing
  const sawRetry = traces.some((t) => t.critiqueVerdict === "retry" || t.critiqueVerdict === "escalate");
  const finishedClean = traces.some((t) => t.status === "completed" && t.critiqueVerdict === "pass");
  if (sawRetry && finishedClean) triggers.add("error_recovery");

  if (traces.some((t) => t.humanCorrected)) triggers.add("human_correction");

  const taskType = traces[0].taskType;
  const bestScore = Math.max(...traces.map((t) => t.evalScore ?? 0));
  if (bestScore >= highScore && !existing.has(taskType)) triggers.add("high_score_no_skill");

  // Metric monitor override: a degraded live skill always warrants a FIX pass.
  if (options.degradedHealth) triggers.add("skill_health");

  return { shouldDistill: triggers.size > 0, triggers: [...triggers] };
}

/** Minimal repository contract — Prisma slice implements this later. */
export interface TraceStore {
  append(record: TraceRecord): Promise<void>;
  /** All traces for a company, optionally filtered by task type, newest first. */
  query(companyId: string, taskType?: string): Promise<TraceRecord[]>;
  byRun(runId: string): Promise<TraceRecord[]>;
}

/** In-memory implementation for local dev and tests. */
export class InMemoryTraceStore implements TraceStore {
  private records: TraceRecord[] = [];

  async append(record: TraceRecord): Promise<void> {
    this.records.push(record);
  }

  async query(companyId: string, taskType?: string): Promise<TraceRecord[]> {
    return this.records
      .filter((r) => r.companyId === companyId && (taskType === undefined || r.taskType === taskType))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async byRun(runId: string): Promise<TraceRecord[]> {
    return this.records.filter((r) => r.runId === runId);
  }
}
