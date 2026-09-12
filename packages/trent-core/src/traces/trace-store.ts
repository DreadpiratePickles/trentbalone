/**
 * `@trent/core` wrapper over `apps/web/lib/trace-store.ts`.
 *
 * trace-store.ts is pure: type-only imports, no I/O, no LLM. So this is a thin
 * typed re-export layer. The one thing it does NOT do is re-export the app's
 * types: `TraceRecord` there reaches into `@/lib/types` and
 * `@/lib/orchestrator-runtime`, and pulling those into the package's public API
 * drags the whole web type graph into every consumer's `tsc` run (Stage 00
 * audit, "API hygiene at the package boundary"). Every type below is declared
 * locally and is structurally identical to the app's.
 *
 * Wraps: apps/web/lib/trace-store.ts
 */

import {
  deriveTraceRecord as libDeriveTraceRecord,
  shouldDistillSkill as libShouldDistillSkill,
  InMemoryTraceStore as LibInMemoryTraceStore,
} from "@/lib/trace-store";

// ─── Locally declared types (structurally identical to the app's) ────────────

/** The nine orchestrator seats. Mirrors `AgentRole` in apps/web/lib/types.ts. */
export type AgentRole =
  | "ceo"
  | "engineer"
  | "growth"
  | "content"
  | "support"
  | "analyst"
  | "finance"
  | "escalation"
  | "sales";

/** Mirrors `StepRecord["status"]` in apps/web/lib/orchestrator-runtime.ts. */
export type TraceStepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "awaiting_approval";

/** Mirrors `OrchestrationCritique["verdict"]`. */
export type CritiqueVerdict = "pass" | "retry" | "replan" | "escalate";

/** A distilled, queryable record of one orchestrator step. */
export type TraceRecord = {
  id: string;
  companyId: string;
  runId: string;
  /** Stable grouping key for "tasks of this kind" — used by Foundry and GEPA. */
  taskType: string;
  agentRole: AgentRole;
  stepTitle: string;
  status: TraceStepStatus;
  toolCalls: string[];
  toolCallCount: number;
  critiqueVerdict?: CritiqueVerdict;
  /** The critic's natural-language improvement note — GEPA's reflection signal. */
  improvement?: string;
  evalScore?: number;
  costCents: number;
  latencyMs?: number;
  humanCorrected: boolean;
  skillApplied?: boolean;
  createdAt: string;
};

/**
 * The narrow slice of an orchestrator `StepRecord` that trace derivation reads.
 * Declared structurally so a CLI caller can build one without importing the
 * orchestrator runtime.
 */
export type OrchestratorStepLike = {
  id: string;
  title: string;
  agentRole: AgentRole;
  status: TraceStepStatus;
  toolCalls?: Array<string | { adapter?: string; tool?: string; name?: string }>;
  critique?: { verdict: CritiqueVerdict; reason?: string; improvement?: string };
  costCents?: number;
  startedAt?: string;
  completedAt?: string;
};

export type DeriveTraceContext = {
  companyId: string;
  runId: string;
  taskType: string;
  evalScore?: number;
  humanCorrected?: boolean;
  skillApplied?: boolean;
  /** Injectable for determinism in tests. */
  id?: string;
  now?: string;
};

export type DistillTrigger =
  | "tool_call_threshold"
  | "error_recovery"
  | "high_score_no_skill"
  | "human_correction"
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
  /** Set by the metric monitor when this task type's live skill has degraded. */
  degradedHealth?: boolean;
};

/** Repository contract. The Prisma-backed slice implements the same shape. */
export interface TraceStore {
  append(record: TraceRecord): Promise<void>;
  /** All traces for a company, optionally filtered by task type, newest first. */
  query(companyId: string, taskType?: string): Promise<TraceRecord[]>;
  byRun(runId: string): Promise<TraceRecord[]>;
}

// ─── Wrapped behaviour ───────────────────────────────────────────────────────

/** Turn a completed orchestrator step into a persisted trace record. */
export function deriveTrace(
  step: OrchestratorStepLike,
  ctx: DeriveTraceContext,
): TraceRecord {
  return libDeriveTraceRecord(
    step as unknown as Parameters<typeof libDeriveTraceRecord>[0],
    ctx,
  ) as TraceRecord;
}

/**
 * Hermes-style trigger check across the traces of a single run: returns which
 * triggers fired and whether the run is worth distilling into a skill.
 */
export function shouldDistillSkill(
  traces: readonly TraceRecord[],
  options: DistillOptions = {},
): DistillDecision {
  return libShouldDistillSkill(
    traces as unknown as Parameters<typeof libShouldDistillSkill>[0],
    options,
  ) as DistillDecision;
}

/** In-memory `TraceStore` for the CLI's standalone mode, local dev and tests. */
export class InMemoryTraceStore implements TraceStore {
  private readonly inner = new LibInMemoryTraceStore();

  async append(record: TraceRecord): Promise<void> {
    await this.inner.append(record as unknown as Parameters<LibInMemoryTraceStore["append"]>[0]);
  }

  async query(companyId: string, taskType?: string): Promise<TraceRecord[]> {
    return (await this.inner.query(companyId, taskType)) as unknown as TraceRecord[];
  }

  async byRun(runId: string): Promise<TraceRecord[]> {
    return (await this.inner.byRun(runId)) as unknown as TraceRecord[];
  }
}
