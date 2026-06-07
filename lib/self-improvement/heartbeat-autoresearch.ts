/**
 * Heartbeat autoresearch sweep — Slice 3 wiring.
 *
 * Runs the SAFE, HONEST subset of the self-improvement loop inside the heartbeat:
 *   persist traces → distill skill drafts to quarantine (persisted) → log one
 *   iteration per draft → raise a HUMAN-REVIEW approval per draft (no auto-promote).
 *
 * Deliberately NON-blocking: each task-type group is wrapped in try/catch and the
 * function never throws — errors are collected into the returned report.
 *
 * SCOPE NOTE (Slice 2 deferral): live candidate execution that produces fresh eval
 * "actuals" is NOT built yet, so there is nothing real to score a candidate against.
 * Therefore this sweep does NO numeric eval-gating — drafts go straight to a human-
 * review approval (decision "pending_approval", unscored). Numeric eval-gate scoring
 * lands in Slice 2; nothing here auto-promotes to the live skill set.
 */

import { appendAuditLog } from "@/lib/audit-log";
import {
  distillSkillFromTraces,
  type SkillDraftStore,
} from "@/lib/skill-foundry";
import type { TraceRecord, TraceStore } from "@/lib/trace-store";
import {
  buildIteration,
  type IterationLog,
} from "@/lib/self-improvement/iteration-log";
import type { ApprovalSink } from "@/lib/self-improvement/promotion";

export type AutoresearchSweepDeps = {
  traceStore: TraceStore;
  draftStore: SkillDraftStore;
  iterationLog: IterationLog;
  approvals: ApprovalSink;
  /** Injectable audit writer — defaults to appendAuditLog. */
  auditLog?: typeof appendAuditLog;
  /** Skip the LLM and use the deterministic fallback skill (tests). */
  skipLLM?: boolean;
  /** Injectable clock for determinism in tests. */
  now?: string;
};

export type AutoresearchSweepReport = {
  draftsDistilled: number;
  approvalsRaised: number;
  errors: string[];
};

/**
 * Run one autoresearch sweep for a company.
 *
 * 1. Harvest traces. If none, return a zeroed report.
 * 2. Group by task type. For each group with enough signal, distill a draft to
 *    quarantine, raise a human-review approval, and log a `pending_approval`
 *    iteration. Never promotes; never throws.
 */
export async function runAutoresearchSweep(
  companyId: string,
  deps: AutoresearchSweepDeps,
): Promise<AutoresearchSweepReport> {
  const report: AutoresearchSweepReport = {
    draftsDistilled: 0,
    approvalsRaised: 0,
    errors: [],
  };

  const auditLog = deps.auditLog ?? appendAuditLog;

  const traces = await deps.traceStore.query(companyId);
  if (traces.length === 0) return report;

  // Group traces by task type.
  const byTaskType = new Map<string, TraceRecord[]>();
  for (const t of traces) {
    byTaskType.set(t.taskType, [...(byTaskType.get(t.taskType) ?? []), t]);
  }

  for (const [taskType, group] of byTaskType) {
    try {
      const draft = await distillSkillFromTraces(group, taskType, {
        companyId,
        draftStore: deps.draftStore,
        skipLLM: deps.skipLLM ?? false,
        auditLog,
        now: deps.now,
      });
      if (!draft) continue;
      report.draftsDistilled++;

      // Human-review gate: raise an approval. No numeric eval gate yet (Slice 2).
      const appr = await deps.approvals.create({
        companyId,
        action: "skill.review",
        reason: `Self-improvement skill draft for "${taskType}" — human review (numeric eval gating lands in Slice 2)`,
        previewContent: draft.content,
        previewKind: "diff",
      });
      report.approvalsRaised++;

      // Log the iteration as pending_approval. Unscored (no score/delta) — deferred to Slice 2.
      await deps.iterationLog.append(
        buildIteration({
          companyId,
          taskType,
          candidateId: draft.id,
          candidateKind: "skill",
          decision: "pending_approval",
          triggers: draft.triggeredBy,
          approvalId: appr.id,
          now: deps.now,
        }),
      );

      // NOTE: intentionally NO draftStore.promote — nothing auto-promotes to live.
    } catch (err) {
      report.errors.push(
        `autoresearch[${taskType}]: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return report;
}
