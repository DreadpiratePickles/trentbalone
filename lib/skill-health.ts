/**
 * Skill Health — metric-driven evolution trigger (OpenSpace-inspired).
 *
 * The existing self-improvement loop (trace-store → skill-foundry → eval-gate →
 * gepa) learns from *wins*: a run that crosses a Hermes trigger gets distilled.
 * It has no way to notice a *promoted* skill quietly rotting — a workflow that
 * still "completes" but increasingly limps through retries and human fixes.
 *
 * HKUDS/OpenSpace solves this with a metric monitor that periodically scans
 * skill health (applied / completion / fallback rates) and re-evolves the
 * underperformers. This module is Trent's version: pure functions that derive
 * per-task-type health from the traces we already persist, and a degradation
 * predicate the heartbeat sweep uses to force a FIX pass on rotting skills.
 *
 * Applied rate: OpenSpace instruments whether a skill was actually loaded into
 * context. Trent now records that per trace (`TraceRecord.skillApplied`, set when
 * `loadCompanySkillInstructions` injects a live skill for the step), so we compute
 * a real `appliedRate` — not a fabricated one. When a task type HAS a live skill
 * but the skill is rarely applied, that is itself a degradation signal (the skill
 * is being bypassed). Traces that predate the instrumentation simply count as
 * not-applied, so appliedRate is conservative rather than wrong.
 *
 * No LLM calls, no I/O. See lib/trace-store.ts for the TraceRecord shape.
 */

import type { TraceRecord } from "@/lib/trace-store";

export type SkillHealth = {
  taskType: string;
  /** Number of traces the health is computed from. */
  sampleSize: number;
  /** Fraction that finished cleanly (status completed AND critic verdict pass). */
  completionRate: number;
  /** Fraction that needed a recovery path (verdict retry/replan/escalate). */
  fallbackRate: number;
  /** Fraction whose step outright failed. */
  failureRate: number;
  /** Fraction a human had to approve/correct — a strong rot signal. */
  humanCorrectionRate: number;
  /** Fraction in which the live skill was actually injected into context. */
  appliedRate: number;
};

export type SkillHealthThresholds = {
  /** Need at least this many traces before health is trustworthy. */
  minSampleSize: number;
  /** Below this completion rate → degraded. */
  minCompletionRate: number;
  /** Above this fallback rate → degraded. */
  maxFallbackRate: number;
  /** Above this failure rate → degraded. */
  maxFailureRate: number;
  /** Above this human-correction rate → degraded. */
  maxHumanCorrectionRate: number;
  /**
   * Below this applied rate → degraded (the live skill is being bypassed).
   * Set to 0 to disable the applied-rate check (e.g. before injection is live
   * everywhere, to avoid flagging skills purely for low historical adoption).
   */
  minAppliedRate: number;
};

export const DEFAULT_SKILL_HEALTH_THRESHOLDS: SkillHealthThresholds = {
  minSampleSize: 3,
  minCompletionRate: 0.6,
  maxFallbackRate: 0.4,
  maxFailureRate: 0.2,
  maxHumanCorrectionRate: 0.34,
  // Off by default: applied-rate is informational until injection is fully wired
  // across the live run path. Flip to e.g. 0.5 once that lands.
  minAppliedRate: 0,
};

const FALLBACK_VERDICTS = new Set(["retry", "replan", "escalate"]);

/** Compute health for a single task type's traces. */
export function computeSkillHealth(taskType: string, traces: readonly TraceRecord[]): SkillHealth {
  const sampleSize = traces.length;
  if (sampleSize === 0) {
    return {
      taskType,
      sampleSize: 0,
      completionRate: 0,
      fallbackRate: 0,
      failureRate: 0,
      humanCorrectionRate: 0,
      appliedRate: 0,
    };
  }

  let completed = 0;
  let fallback = 0;
  let failed = 0;
  let corrected = 0;
  let applied = 0;
  for (const t of traces) {
    if (t.status === "completed" && t.critiqueVerdict === "pass") completed++;
    if (t.critiqueVerdict && FALLBACK_VERDICTS.has(t.critiqueVerdict)) fallback++;
    if (t.status === "failed") failed++;
    if (t.humanCorrected) corrected++;
    if (t.skillApplied) applied++;
  }

  return {
    taskType,
    sampleSize,
    completionRate: completed / sampleSize,
    fallbackRate: fallback / sampleSize,
    failureRate: failed / sampleSize,
    humanCorrectionRate: corrected / sampleSize,
    appliedRate: applied / sampleSize,
  };
}

/**
 * Is this skill degraded enough to warrant a forced FIX pass?
 * Returns false below the minimum sample size — we never evolve on noise.
 */
export function isSkillDegraded(
  health: SkillHealth,
  thresholds: SkillHealthThresholds = DEFAULT_SKILL_HEALTH_THRESHOLDS,
): boolean {
  if (health.sampleSize < thresholds.minSampleSize) return false;
  return (
    health.completionRate < thresholds.minCompletionRate ||
    health.fallbackRate > thresholds.maxFallbackRate ||
    health.failureRate > thresholds.maxFailureRate ||
    health.humanCorrectionRate > thresholds.maxHumanCorrectionRate ||
    (thresholds.minAppliedRate > 0 && health.appliedRate < thresholds.minAppliedRate)
  );
}

/** Human-readable reason a skill was flagged (for audit logs + CEO summaries). */
export function describeDegradation(
  health: SkillHealth,
  thresholds: SkillHealthThresholds = DEFAULT_SKILL_HEALTH_THRESHOLDS,
): string[] {
  const reasons: string[] = [];
  if (health.sampleSize < thresholds.minSampleSize) return reasons;
  if (health.completionRate < thresholds.minCompletionRate) {
    reasons.push(`completion ${(health.completionRate * 100).toFixed(0)}% < ${(thresholds.minCompletionRate * 100).toFixed(0)}%`);
  }
  if (health.fallbackRate > thresholds.maxFallbackRate) {
    reasons.push(`fallback ${(health.fallbackRate * 100).toFixed(0)}% > ${(thresholds.maxFallbackRate * 100).toFixed(0)}%`);
  }
  if (health.failureRate > thresholds.maxFailureRate) {
    reasons.push(`failure ${(health.failureRate * 100).toFixed(0)}% > ${(thresholds.maxFailureRate * 100).toFixed(0)}%`);
  }
  if (health.humanCorrectionRate > thresholds.maxHumanCorrectionRate) {
    reasons.push(`human-correction ${(health.humanCorrectionRate * 100).toFixed(0)}% > ${(thresholds.maxHumanCorrectionRate * 100).toFixed(0)}%`);
  }
  if (thresholds.minAppliedRate > 0 && health.appliedRate < thresholds.minAppliedRate) {
    reasons.push(`applied ${(health.appliedRate * 100).toFixed(0)}% < ${(thresholds.minAppliedRate * 100).toFixed(0)}% (skill bypassed)`);
  }
  return reasons;
}

/**
 * Scan all task types that currently have a live skill and return the degraded
 * ones, worst-first. This is the metric monitor the heartbeat sweep calls.
 */
export function scanDegradedSkills(
  tracesByTaskType: Map<string, readonly TraceRecord[]>,
  liveTaskTypes: readonly string[],
  thresholds: SkillHealthThresholds = DEFAULT_SKILL_HEALTH_THRESHOLDS,
): SkillHealth[] {
  const live = new Set(liveTaskTypes);
  const degraded: SkillHealth[] = [];
  for (const [taskType, traces] of tracesByTaskType) {
    if (!live.has(taskType)) continue;
    const health = computeSkillHealth(taskType, traces);
    if (isSkillDegraded(health, thresholds)) degraded.push(health);
  }
  // Worst completion first — the sweep evolves the most rotten skills first.
  return degraded.sort((a, b) => a.completionRate - b.completionRate);
}
