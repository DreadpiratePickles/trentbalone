/**
 * lib/goal-types.ts — Zod contracts + TS types for the §2 Goal Loop.
 *
 * A Goal is a persistent object with explicit, measurable success criteria. The
 * orchestrator runs ROUNDS against it: each round plans tasks for unmet
 * criteria, seats produce typed artifacts, a critic judges each artifact with
 * evidence, and the CEO maps artifacts → criteria. The Goal is the external
 * memory — every JSON column here is validated on read/write so a round never
 * operates on a malformed ledger (MAST inter-agent-misalignment mitigation).
 */
import { z } from "zod";

export const criterionStatusEnum = z.enum(["unmet", "met", "blocked"]);
export type CriterionStatus = z.infer<typeof criterionStatusEnum>;

export const successCriterionSchema = z.object({
  id: z.string(),
  text: z.string().min(1),
  status: criterionStatusEnum.default("unmet"),
  evidenceArtifactIds: z.array(z.string()).default([]),
});
export type SuccessCriterion = z.infer<typeof successCriterionSchema>;

export const goalConstraintsSchema = z.object({
  budgetCentsCap: z.number().int().nonnegative().default(5000),
  deadline: z.string().optional(),
  approvalsPolicy: z.enum(["gate_each_round", "auto_low_risk"]).default("gate_each_round"),
});
export type GoalConstraints = z.infer<typeof goalConstraintsSchema>;

export const criteriaDeltaSchema = z.object({
  criterionId: z.string(),
  from: criterionStatusEnum,
  to: criterionStatusEnum,
  evidenceArtifactIds: z.array(z.string()).default([]),
});
export type CriteriaDelta = z.infer<typeof criteriaDeltaSchema>;

export const goalRoundSchema = z.object({
  n: z.number().int().positive(),
  runId: z.string(),
  plannedTaskCount: z.number().int().nonnegative(),
  costCents: z.number().int().nonnegative().default(0),
  criteriaDelta: z.array(criteriaDeltaSchema).default([]),
  summary: z.string().default(""),
  artifactIds: z.array(z.string()).default([]),
  at: z.string(),
});
export type GoalRound = z.infer<typeof goalRoundSchema>;

export const progressLogEntrySchema = z.object({
  at: z.string(),
  kind: z.enum(["intake", "criteria_approved", "round_planned", "round_executed", "round_review", "stopped", "completed", "edited", "degraded"]),
  text: z.string(),
  refs: z.array(z.string()).default([]),
});
export type ProgressLogEntry = z.infer<typeof progressLogEntrySchema>;

export const goalStatusEnum = z.enum([
  "intake",
  "active",
  "round_running",
  "awaiting_review",
  "completed",
  "stopped",
]);
export type GoalStatus = z.infer<typeof goalStatusEnum>;

export const goalSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  objective: z.string().min(1),
  status: goalStatusEnum,
  successCriteria: z.array(successCriterionSchema),
  constraints: goalConstraintsSchema,
  rounds: z.array(goalRoundSchema),
  progressLog: z.array(progressLogEntrySchema),
  costCents: z.number().int().nonnegative().default(0),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Goal = z.infer<typeof goalSchema>;

// ── Intake (CEO model → measurable criteria) ──────────────────────────────────

export const goalIntakeSchema = z.object({
  objective: z.string().min(1),
  successCriteria: z.array(z.object({ text: z.string().min(1) })).min(1).max(8),
  budgetEstimateCents: z.number().int().nonnegative(),
  rationale: z.string().default(""),
});
export type GoalIntake = z.infer<typeof goalIntakeSchema>;

// ── Round planning (planner model → typed, effort-scaled subtasks) ────────────

export const goalTaskSchema = z.object({
  id: z.string(),
  seat: z.enum(["ceo", "engineer", "growth", "content", "support", "finance", "analyst", "escalation", "sales"]),
  /** Specific, output-shaped objective — NOT "engineer contribution for X". */
  objective: z.string().min(1),
  /** Zod output contract the seat must satisfy (seat-output-schemas). */
  outputContractId: z.string().min(1),
  toolGuidance: z.array(z.string()).default([]),
  boundaries: z.array(z.string()).default([]),
  /** Step ids this task depends on (DAG edges). */
  dependsOn: z.array(z.string()).default([]),
  /** Which success criteria this task targets. */
  targetsCriteriaIds: z.array(z.string()).default([]),
  riskLevel: z.enum(["low", "medium", "high"]).default("low"),
  budgetCents: z.number().int().nonnegative().default(50),
});
export type GoalTask = z.infer<typeof goalTaskSchema>;

export const goalRoundPlanSchema = z.object({
  reasoning: z.string().default(""),
  effort: z.enum(["trivial", "standard", "complex"]).default("standard"),
  tasks: z.array(goalTaskSchema).min(1).max(12),
});
export type GoalRoundPlan = z.infer<typeof goalRoundPlanSchema>;

// ── CEO round review (map artifacts → criteria) ───────────────────────────────

export const goalReviewSchema = z.object({
  summary: z.string().min(1),
  criteriaUpdates: z.array(z.object({
    criterionId: z.string(),
    status: criterionStatusEnum,
    evidenceArtifactIds: z.array(z.string()).default([]),
    reason: z.string().default(""),
  })).default([]),
  allCriteriaMet: z.boolean().default(false),
  nextRoundProposal: z.array(z.object({
    seat: z.string(),
    objective: z.string(),
    targetsCriteriaIds: z.array(z.string()).default([]),
  })).default([]),
});
export type GoalReview = z.infer<typeof goalReviewSchema>;
