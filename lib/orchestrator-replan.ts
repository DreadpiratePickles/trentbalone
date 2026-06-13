import type { Company } from "@/lib/types";
import { nowIso } from "@/lib/utils";
import { callJson, MAX_TOKENS, MODELS } from "@/lib/ai-client";
import { z } from "zod";
import type {
  OrchestrationCritique,
  OrchestrationPlan,
  OrchestrationStep,
  StepRecord,
} from "@/lib/orchestrator-runtime";
import {
  agentRoles,
  normalizePlannerAgentRole,
  normalizePlannerRiskLevel,
  repairOrchestrationPlanRoutes,
  sanitizeReadOnlyApprovalGates,
} from "@/lib/orchestrator-runtime";

/** Mirror MAX_DELEGATION_DEPTH from orchestrator-delegation.ts */
export const MAX_REPLANS = 2;

const PLANNER_MODEL = process.env.PLANNER_MODEL ?? MODELS.STRONG;

function normalizeReplanBoolean(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const normalized = value.toLowerCase().trim();
  if (/^(true|yes|y|1|required|approval required)$/.test(normalized)) return true;
  if (/^(false|no|n|0|none|not required|approval not required)$/.test(normalized)) return false;
  return value;
}

function normalizeReplanStringList(value: unknown): unknown {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || /^(none|n\/a|na|no blockers?|no dependencies?)$/i.test(trimmed)) return [];
  return trimmed
    .split(/[\n;,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

const roleSchema = z.preprocess(normalizePlannerAgentRole, z.enum(agentRoles));
const riskSchema = z.preprocess(normalizePlannerRiskLevel, z.enum(["low", "medium", "high"]));
const booleanSchema = z.preprocess(normalizeReplanBoolean, z.boolean());
const stringListSchema = z.preprocess(normalizeReplanStringList, z.array(z.string()));

const tailStepSchema = z.object({
  id: z.string(),
  title: z.string(),
  rationale: z.string(),
  agentRole: roleSchema,
  dependsOn: stringListSchema.default([]),
  expectedOutput: z.string(),
  riskLevel: riskSchema,
  needsApproval: booleanSchema.default(false),
});

const tailRevisionSchema = z.object({
  reasoning: z.string(),
  steps: z.array(tailStepSchema).min(1).max(12),
  successCriteria: stringListSchema.optional(),
  blockers: stringListSchema.default([]),
});

export function canApplyReplan(replanCount: number): boolean {
  return replanCount < MAX_REPLANS;
}

function sanitizeRevisedTailDependencies(input: {
  completedSteps: StepRecord[];
  failedStepId: string;
  revisedTail: OrchestrationStep[];
}): OrchestrationStep[] {
  const completedIds = new Set(input.completedSteps.map((step) => step.id));
  const anchorId = input.completedSteps[input.completedSteps.length - 1]?.id;
  const priorTailIds = new Set<string>();

  return input.revisedTail.map((step) => {
    const validDeps = Array.from(new Set(step.dependsOn ?? [])).filter((dep) => (
      dep !== input.failedStepId
      && dep !== step.id
      && (completedIds.has(dep) || priorTailIds.has(dep))
    ));
    priorTailIds.add(step.id);

    return {
      ...step,
      dependsOn: validDeps.length ? validDeps : (anchorId && step.id !== anchorId ? [anchorId] : []),
      needsApproval: step.needsApproval ?? false,
    };
  });
}

export function applyRevisedPlanTail(input: {
  steps: StepRecord[];
  failedStepId: string;
  revisedTail: OrchestrationStep[];
}): StepRecord[] {
  const failedIdx = input.steps.findIndex((step) => step.id === input.failedStepId);
  if (failedIdx < 0) return input.steps;

  const completed = input.steps.filter((step) => step.status === "completed");
  const failedStep = input.steps[failedIdx];
  const failed: StepRecord = {
    ...failedStep,
    status: "failed",
    completedAt: nowIso(),
    critique: failedStep.critique ?? { verdict: "replan", reason: "structural failure — tail revised" },
  };

  const sanitizedTail = sanitizeRevisedTailDependencies({
    completedSteps: completed,
    failedStepId: input.failedStepId,
    revisedTail: input.revisedTail,
  });

  const newTail: StepRecord[] = sanitizedTail.map((step) => ({
    ...step,
    dependsOn: step.dependsOn ?? [],
    needsApproval: step.needsApproval ?? false,
    status: "pending",
  }));

  return [...completed, failed, ...newTail];
}

function buildDeterministicRevisedTail(
  completedSteps: StepRecord[],
  failedStep: StepRecord,
  critique: OrchestrationCritique,
): OrchestrationStep[] {
  const lastCompleted = completedSteps[completedSteps.length - 1];
  const anchorId = lastCompleted?.id ?? "s1";
  const maxId = [...completedSteps, failedStep].reduce((highest, step) => {
    const match = /^s(\d+)$/.exec(step.id);
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 0);
  const recoveryId = `s${maxId + 1}`;
  const consolidateId = `s${maxId + 2}`;

  return [
    {
      id: recoveryId,
      title: `Recovery: revised approach after ${failedStep.title}`,
      rationale: critique.reason || "Structural plan failure — replanning the unfinished tail.",
      agentRole: failedStep.agentRole === "ceo" ? "engineer" : failedStep.agentRole,
      dependsOn: [anchorId],
      expectedOutput: `Deliver a corrected outcome for "${failedStep.expectedOutput}" using a revised strategy.`,
      riskLevel: failedStep.riskLevel,
      needsApproval: failedStep.needsApproval,
    },
    {
      id: consolidateId,
      title: "Consolidate revised run output",
      rationale: "CEO wraps the recovery path into a founder-ready brief.",
      agentRole: "ceo",
      dependsOn: [recoveryId],
      expectedOutput: "Single-screen summary of the recovery output and next action.",
      riskLevel: "low",
      needsApproval: false,
    },
  ];
}

export function buildReplanPlanningPrompts(
  company: Company,
  objective: string,
  memory: string,
  input: {
    plan: OrchestrationPlan;
    completedSteps: StepRecord[];
    failedStep: StepRecord;
    critique: OrchestrationCritique;
  },
): { system: string; user: string } {
  const completedSummary = input.completedSteps
    .map((step) => `- ${step.id} [${step.status}] ${step.title}: ${(step.handoff?.summary ?? step.output)?.slice(0, 400) ?? "(no output)"}`)
    .join("\n");

  const system = [
    "You are Trent's orchestration replanner. A step revealed the plan shape was wrong.",
    "Revise ONLY the unfinished tail — keep every completed step id and output as-is.",
    "Do not re-assign or re-run completed steps. New tail steps must depend on completed step ids.",
    "You may insert, modify, or remove remaining steps. Always end with a ceo consolidation step.",
    "Output strict JSON: { reasoning, steps:[{id,title,rationale,agentRole,dependsOn,expectedOutput,riskLevel,needsApproval}], successCriteria?, blockers? }",
  ].join("\n");

  const user = [
    `Company: ${company.name}`,
    `Objective: ${objective}`,
    memory ? `Memory:\n${memory}` : "",
    "",
    `Original plan reasoning: ${input.plan.reasoning}`,
    `Success criteria: ${input.plan.successCriteria.join("; ")}`,
    "",
    "Completed steps (immutable — do not change):",
    completedSummary || "(none)",
    "",
    `Failed step: ${input.failedStep.id} — ${input.failedStep.title}`,
    `Failure output: ${input.failedStep.output?.slice(0, 1200) ?? "(none)"}`,
    `Supervisor verdict: ${input.critique.verdict} — ${input.critique.reason}`,
    input.critique.improvement ? `Improvement hint: ${input.critique.improvement}` : "",
    "",
    "Return a revised tail only (not the completed steps). Use new step ids that do not collide with completed ids.",
  ].filter(Boolean).join("\n");

  return { system, user };
}

export async function reviseOrchestrationPlanTail(
  company: Company,
  objective: string,
  memory: string,
  input: {
    plan: OrchestrationPlan;
    completedSteps: StepRecord[];
    failedStep: StepRecord;
    critique: OrchestrationCritique;
  },
): Promise<OrchestrationPlan> {
  const completedIds = new Set(input.completedSteps.map((step) => step.id));
  const fallbackTail = buildDeterministicRevisedTail(input.completedSteps, input.failedStep, input.critique);
  const fallback: z.infer<typeof tailRevisionSchema> = {
    reasoning: `Deterministic tail revision after structural failure on ${input.failedStep.id}.`,
    steps: fallbackTail,
    successCriteria: input.plan.successCriteria,
    blockers: input.plan.blockers,
  };

  const prompts = buildReplanPlanningPrompts(company, objective, memory, input);
  let revision = fallback;
  try {
    const result = await callJson<z.infer<typeof tailRevisionSchema>>(
      PLANNER_MODEL,
      prompts.system,
      prompts.user,
      tailRevisionSchema,
      MAX_TOKENS.PLANNING,
    );
    revision = result.data;
  } catch (err) {
    console.error("orchestrator.replan_failed", { error: err instanceof Error ? err.message : String(err) });
  }

  const unsanitizedTailSteps = revision.steps
    .filter((step) => !completedIds.has(step.id))
    .map((step) => ({
      ...step,
      dependsOn: step.dependsOn ?? [],
      needsApproval: step.needsApproval ?? false,
    }));
  const tailSteps = sanitizeRevisedTailDependencies({
    completedSteps: input.completedSteps,
    failedStepId: input.failedStep.id,
    revisedTail: unsanitizedTailSteps.length ? unsanitizedTailSteps : fallbackTail,
  });

  const mergedSteps = [
    ...input.completedSteps.map((step) => ({
      id: step.id,
      title: step.title,
      rationale: step.rationale,
      agentRole: step.agentRole,
      dependsOn: step.dependsOn,
      expectedOutput: step.expectedOutput,
      riskLevel: step.riskLevel,
      needsApproval: step.needsApproval,
    })),
    ...tailSteps,
  ];

  const rawPlan: OrchestrationPlan = {
    objective: input.plan.objective,
    reasoning: revision.reasoning,
    steps: mergedSteps,
    successCriteria: revision.successCriteria ?? input.plan.successCriteria,
    blockers: revision.blockers ?? input.plan.blockers,
  };

  return sanitizeReadOnlyApprovalGates(repairOrchestrationPlanRoutes({
    ...rawPlan,
    blockers: rawPlan.blockers ?? [],
    steps: rawPlan.steps.map((step) => ({
      ...step,
      dependsOn: step.dependsOn ?? [],
      needsApproval: step.needsApproval ?? false,
    })),
  }), input.plan.objective);
}

export function buildEscalationReplanPrompt(
  step: StepRecord,
  critique: OrchestrationCritique,
  proposedReplan?: OrchestrationPlan,
): string {
  const tailLines = proposedReplan?.steps
    .filter((item) => item.id !== step.id)
    .map((item) => `  - ${item.id}: ${item.title} (${item.agentRole}) — ${item.expectedOutput.slice(0, 120)}`)
    .join("\n") ?? "  (no replan generated)";

  return [
    `Orchestration blocked on step "${step.title}" (${step.id}).`,
    `Reason: ${critique.reason}`,
    "",
    "## Proposed replan",
    proposedReplan?.reasoning ?? "The supervisor could not auto-apply another replan.",
    tailLines,
    "",
    "Reply to approve this new path, or redirect the team with updated instructions.",
  ].join("\n");
}
