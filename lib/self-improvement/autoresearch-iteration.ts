/**
 * Autoresearch Iteration — one full pass of Trent's self-improvement loop,
 * modeled on karpathy/autoresearch's methodology:
 *
 *   propose change → score on a FIXED frozen metric → keep-if-better-else-revert
 *   → log the iteration.
 *
 * "Keep" here means *raise a pending approval* (humans gate live writes); "revert"
 * means discard the quarantine candidate. The orchestrator (`lib/orchestrator.ts`)
 * and the eval graders are the FIXED harness — this module never edits them. The
 * editable layer is the SKILL.md body proposed by the Skill Foundry.
 *
 * Slice 1 scores against REPLAYED actuals (see actuals-provider.ts): deterministic
 * and zero-spend. Live candidate execution is the next slice and plugs in behind
 * the ActualsProvider seam without touching this control flow.
 */

import type { EvalGrader } from "@/lib/eval-harness";
import type { appendAuditLog } from "@/lib/audit-log";
import { distillSkillFromTraces, type SkillDraftStore } from "@/lib/skill-foundry";
import { promoteCandidate, type EvalGateBaseline } from "@/lib/eval-gate";
import type { TraceRecord } from "@/lib/trace-store";
import type { ActualsProvider } from "@/lib/self-improvement/actuals-provider";
import { buildSkillEvalSuite, type SkillEval, type SkillEvalsJson } from "@/lib/self-improvement/frozen-suite";
import {
  requestPromotion,
  type ApprovalSink,
} from "@/lib/self-improvement/promotion";
import {
  buildIteration,
  type IterationDecision,
  type IterationLog,
} from "@/lib/self-improvement/iteration-log";

export type IterationDeps = {
  draftStore: SkillDraftStore;
  approvals: ApprovalSink;
  iterationLog: IterationLog;
  auditLog: typeof appendAuditLog;
};

export type RunSkillIterationInput = {
  companyId: string;
  taskType: string;
  /** Recent traces for this task type (the learning signal). */
  traces: readonly TraceRecord[];
  /** The skill's frozen `evals.json` — the objective metric. */
  skill: SkillEvalsJson;
  /** Recorded actuals for the frozen suite (Slice 1: replayed). */
  actuals: ActualsProvider;
  /** Current production score + failure clusters for this skill. */
  baseline: EvalGateBaseline;
  deps: IterationDeps;
  /** Override per-eval graders (mechanical grading / tests). */
  gradersFor?: (ev: SkillEval) => EvalGrader[];
  /** Skip the Foundry LLM (tests / cost control). */
  skipLLM?: boolean;
  /** Candidate version label. */
  version?: string;
  id?: string;
  now?: string;
};

export type IterationOutcome = {
  decision: IterationDecision;
  candidateId?: string;
  score?: number;
  delta?: number;
  /** Set when decision === "pending_approval". */
  approvalId?: string;
  /** Set when decision === "rejected". */
  blockedBy?: "regression" | "new_failure_cluster";
  /** Full candidate SKILL.md content (for callers/UI). */
  candidateContent?: string;
};

/**
 * Run one self-improvement iteration for a single skill / task type.
 *
 * No live-tenant side effects: the candidate only ever reaches quarantine; a
 * passing candidate raises a pending approval, a failing one is discarded. The
 * live skill set is never written here.
 */
export async function runSkillIteration(input: RunSkillIterationInput): Promise<IterationOutcome> {
  const { companyId, taskType, traces, skill, actuals, baseline, deps } = input;
  const version = input.version ?? "1.0.0";

  // 1. Propose — distill a candidate SKILL.md from the run traces (→ quarantine).
  const draft = await distillSkillFromTraces(traces, taskType, {
    companyId,
    draftStore: deps.draftStore,
    skipLLM: input.skipLLM ?? false,
    auditLog: deps.auditLog,
    id: input.id,
    now: input.now,
  });

  if (!draft) {
    await deps.iterationLog.append(
      buildIteration({ companyId, taskType, decision: "no_candidate", triggers: [], now: input.now }),
    );
    return { decision: "no_candidate" };
  }

  // 2. Score — run the candidate against the FROZEN suite (replayed actuals).
  const frozenSuite = buildSkillEvalSuite({ skill, actuals, gradersFor: input.gradersFor });
  const decision = await promoteCandidate(
    { id: draft.id, type: "skill", version },
    frozenSuite,
    baseline,
  );

  const triggers = draft.triggeredBy;
  const liveContent = await deps.draftStore.readLive(companyId, taskType);

  // 3a. Keep — passing candidate raises a pending approval (no live write).
  if (decision.promoted) {
    const approvalId = await requestPromotion({
      companyId,
      taskType,
      candidateId: draft.id,
      candidateKind: "skill",
      decision,
      liveContent,
      candidateContent: draft.content,
      triggers,
      deps,
      now: input.now,
    });
    return {
      decision: "pending_approval",
      candidateId: draft.id,
      score: decision.score,
      delta: decision.delta,
      approvalId,
      candidateContent: draft.content,
    };
  }

  // 3b. Revert — failing candidate is discarded with an audit trail.
  await deps.auditLog(
    companyId,
    "agent",
    "skill.rejected",
    "skill_draft",
    draft.id,
    `Candidate for "${taskType}" blocked by ${decision.blockedBy} — score ${decision.score}, Δ${decision.delta}`,
  ).catch(() => {});

  await deps.iterationLog.append(
    buildIteration({
      companyId,
      taskType,
      candidateId: draft.id,
      candidateKind: "skill",
      score: decision.score,
      delta: decision.delta,
      decision: "rejected",
      triggers,
      blockedBy: decision.blockedBy,
      now: input.now,
    }),
  );

  return {
    decision: "rejected",
    candidateId: draft.id,
    score: decision.score,
    delta: decision.delta,
    blockedBy: decision.blockedBy,
    candidateContent: draft.content,
  };
}
