/**
 * Promotion — the approval gate over self-improvement.
 *
 * The existing Eval Gate (`lib/eval-gate.ts`) decides *mechanically* whether a
 * candidate is non-regressing. This module adds the **human** gate the safety
 * model requires: a passing candidate is NOT auto-promoted — it raises a pending
 * approval carrying the quarantine-vs-live diff + score delta, and only a human
 * "approve" moves it live. Every transition is audit-logged; nothing writes to
 * the live skill set without approval.
 *
 * Pure + injectable: the approval queue, iteration log, and audit writer are all
 * passed in, so this is fully unit-testable with no DB.
 */

import type { appendAuditLog } from "@/lib/audit-log";
import type { SkillDraftStore } from "@/lib/skill-foundry";
import type { EvalGateDecision } from "@/lib/eval-gate";
import {
  buildIteration,
  type IterationLog,
  type IterationCandidateKind,
} from "@/lib/self-improvement/iteration-log";

/** Minimal contract over the company approval queue (adapter wraps `store`). */
export interface ApprovalSink {
  create(input: {
    companyId: string;
    action: string;
    reason: string;
    previewContent?: string;
    previewKind?: string;
  }): Promise<{ id: string }>;
}

/**
 * Tiny line-oriented diff for the approval preview. Not a git diff — just enough
 * for a human to see what the candidate changes vs the live skill.
 */
export function buildTextDiff(liveContent: string | undefined, candidateContent: string): string {
  if (liveContent === undefined) {
    return candidateContent
      .split("\n")
      .map((line) => `+ ${line}`)
      .join("\n");
  }
  const liveLines = liveContent.split("\n");
  const candLines = candidateContent.split("\n");
  const max = Math.max(liveLines.length, candLines.length);
  const out: string[] = [];
  for (let i = 0; i < max; i++) {
    const a = liveLines[i];
    const b = candLines[i];
    if (a === b) {
      if (a !== undefined) out.push(`  ${a}`);
    } else {
      if (a !== undefined) out.push(`- ${a}`);
      if (b !== undefined) out.push(`+ ${b}`);
    }
  }
  return out.join("\n");
}

export type PromotionDeps = {
  approvals: ApprovalSink;
  iterationLog: IterationLog;
  auditLog: typeof appendAuditLog;
};

export type RequestPromotionArgs = {
  companyId: string;
  taskType: string;
  candidateId: string;
  candidateKind: IterationCandidateKind;
  /** Eval-gate decision — expected to be `promoted: true`. */
  decision: EvalGateDecision;
  /** Current live content for the diff preview (undefined ⇒ brand-new skill). */
  liveContent?: string;
  /** The quarantine candidate content. */
  candidateContent: string;
  triggers: string[];
  deps: PromotionDeps;
  now?: string;
};

/**
 * Raise a pending approval for a passing candidate, audit it, and log the
 * iteration as `pending_approval`. Returns the approval id. Does NOT promote.
 */
export async function requestPromotion(args: RequestPromotionArgs): Promise<string> {
  const { companyId, taskType, candidateId, candidateKind, decision, deps, triggers } = args;
  const diff = buildTextDiff(args.liveContent, args.candidateContent);

  const approval = await deps.approvals.create({
    companyId,
    action: `${candidateKind}.promotion`,
    reason: `Self-improvement ${candidateKind} candidate for "${taskType}" — score ${decision.score} (Δ${decision.delta})`,
    previewContent: diff,
    previewKind: "diff",
  });

  await deps.auditLog(
    companyId,
    "agent",
    `${candidateKind}.promotion_requested`,
    "skill_draft",
    candidateId,
    `Promotion requested for "${taskType}" — score ${decision.score}, Δ${decision.delta}; approval ${approval.id}`,
  ).catch(() => {});

  await deps.iterationLog.append(
    buildIteration({
      companyId,
      taskType,
      candidateId,
      candidateKind,
      score: decision.score,
      delta: decision.delta,
      decision: "pending_approval",
      triggers,
      approvalId: approval.id,
      now: args.now,
    }),
  );

  return approval.id;
}

export type ResolvePromotionArgs = {
  companyId: string;
  taskType: string;
  candidateId: string;
  candidateKind: IterationCandidateKind;
  draftStore: SkillDraftStore;
  auditLog: typeof appendAuditLog;
};

/**
 * Apply a human decision on a pending promotion.
 * - "approve" → promote the quarantine draft to live + audit.
 * - "reject"  → leave the draft in quarantine + audit (no live write).
 */
export async function resolvePromotion(
  verdict: "approve" | "reject",
  args: ResolvePromotionArgs,
): Promise<void> {
  const { companyId, taskType, candidateId, candidateKind, draftStore, auditLog } = args;

  if (verdict === "approve") {
    await draftStore.promote(companyId, taskType);
    await auditLog(
      companyId,
      "user",
      `${candidateKind}.promoted`,
      "skill_draft",
      candidateId,
      `Approved + promoted ${candidateKind} for "${taskType}" to live`,
    ).catch(() => {});
    return;
  }

  await auditLog(
    companyId,
    "user",
    `${candidateKind}.promotion_rejected`,
    "skill_draft",
    candidateId,
    `Rejected ${candidateKind} promotion for "${taskType}" — draft stays in quarantine`,
  ).catch(() => {});
}
