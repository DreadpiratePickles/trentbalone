import { median, passRate, roundMetric } from "@/lib/eval-scorecard";
import type { OrchestrationStep } from "@/lib/orchestrator-runtime";
import type { TrajectoryCaseResult } from "@/lib/orchestration-eval-trajectory";

export type OrchestrationGoldenObjective = {
  id: string;
  objective: string;
  teamShape: "solo" | "full_team";
};

export type OrchestrationEvalInput = {
  objectiveId: string;
  planValid: boolean;
  stepSuccessRate: number;
  objectiveAchieved: boolean;
  costCents: number;
  wallClockMs: number;
};

export type OrchestrationEvalResult = OrchestrationEvalInput & {
  passed: boolean;
  failureTags: string[];
  trajectory?: TrajectoryCaseResult;
  quarantined?: boolean;
};

export function partitionQuarantinedResults(results: OrchestrationEvalResult[]): {
  blocking: OrchestrationEvalResult[];
  quarantined: OrchestrationEvalResult[];
} {
  return {
    blocking: results.filter((result) => !result.quarantined),
    quarantined: results.filter((result) => result.quarantined),
  };
}

export type OrchestrationReproducibilityResult = {
  objectiveId: string;
  score: number;
  comparable: boolean;
  notes: string[];
};

export type OrchestrationEvalScorecard = {
  suite: "orchestration";
  objectiveCount: number;
  passRate: number;
  medianStepSuccessRate: number;
  medianReproducibility: number;
  medianCostCents: number;
  medianWallClockMs: number;
  objectives: OrchestrationEvalResult[];
  reproducibility: OrchestrationReproducibilityResult[];
};

const GOLDEN_OBJECTIVES: OrchestrationGoldenObjective[] = [
  { id: "orc_weekly_ops", objective: "Run the weekly ops review and produce a CEO summary.", teamShape: "full_team" },
  { id: "orc_churn", objective: "Analyze churn cohorts and recommend retention actions.", teamShape: "solo" },
  { id: "orc_launch_email", objective: "Draft and queue a product launch email sequence.", teamShape: "solo" },
  { id: "orc_support_escalation", objective: "Triage angry customer feedback and route escalation.", teamShape: "solo" },
  { id: "orc_sales_outreach", objective: "Research ICP-fit accounts and draft outreach.", teamShape: "solo" },
  { id: "orc_content_calendar", objective: "Plan a two-week content calendar with channel mix.", teamShape: "solo" },
  { id: "orc_finance_burn", objective: "Review burn, runway, and budget guardrails.", teamShape: "solo" },
  { id: "orc_competitive_scan", objective: "Research competitor pricing and positioning shifts.", teamShape: "solo" },
  { id: "orc_incident_response", objective: "Coordinate an incident response with support and engineering.", teamShape: "full_team" },
  { id: "orc_paid_media_audit", objective: "Audit paid media performance and propose optimizations.", teamShape: "solo" },
  { id: "orc_onboarding_flow", objective: "Improve onboarding activation with product and growth seats.", teamShape: "full_team" },
  { id: "orc_pipeline_review", objective: "Review sales pipeline health and next actions.", teamShape: "solo" },
  { id: "orc_feature_spec", objective: "Turn a founder brief into an engineering-ready spec.", teamShape: "solo" },
  { id: "orc_qbr_prep", objective: "Prepare a quarterly business review packet.", teamShape: "full_team" },
  { id: "orc_hiring_plan", objective: "Draft a hiring plan with role priorities and budget impact.", teamShape: "solo" },
];

export function buildOrchestrationGoldenObjectives(): OrchestrationGoldenObjective[] {
  return GOLDEN_OBJECTIVES.map((item) => ({ ...item }));
}

export function validateOrchestrationPlanDag(steps: OrchestrationStep[]): { valid: boolean; issues: string[] } {
  const issues: string[] = [];
  if (steps.length === 0) {
    return { valid: false, issues: ["empty_plan"] };
  }

  const ids = new Set(steps.map((step) => step.id));
  if (ids.size !== steps.length) {
    issues.push("duplicate_step_id");
  }

  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (!ids.has(dep)) issues.push("unknown_dependency");
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(steps.map((step) => [step.id, step]));

  function dfs(stepId: string): boolean {
    if (visiting.has(stepId)) {
      issues.push("cycle_detected");
      return false;
    }
    if (visited.has(stepId)) return true;
    visiting.add(stepId);
    const step = byId.get(stepId);
    for (const dep of step?.dependsOn ?? []) {
      if (!dfs(dep)) return false;
    }
    visiting.delete(stepId);
    visited.add(stepId);
    return true;
  }

  for (const step of steps) {
    dfs(step.id);
  }

  return { valid: issues.length === 0, issues: [...new Set(issues)] };
}

export function scoreOrchestrationRun(input: OrchestrationEvalInput): OrchestrationEvalResult {
  const failureTags: string[] = [];
  if (!input.planValid) failureTags.push("invalid_plan");
  if (input.stepSuccessRate < 1) failureTags.push("step_failures");
  if (!input.objectiveAchieved) failureTags.push("objective_not_achieved");
  const passed = failureTags.length === 0;
  return { ...input, passed, failureTags };
}

export function compareOrchestrationReproducibility(
  runA: OrchestrationEvalResult,
  runB: OrchestrationEvalResult,
): OrchestrationReproducibilityResult {
  const notes: string[] = [];
  if (runA.objectiveId !== runB.objectiveId) {
    return { objectiveId: runA.objectiveId, score: 0, comparable: false, notes: ["objective_mismatch"] };
  }

  let score = 1;
  if (runA.objectiveAchieved !== runB.objectiveAchieved) {
    score -= 0.5;
    notes.push("objective_achievement_drift");
  }
  if (Math.abs(runA.stepSuccessRate - runB.stepSuccessRate) > 0.05) {
    score -= 0.3;
    notes.push("step_success_drift");
  }
  if (runA.planValid !== runB.planValid) {
    score -= 0.2;
    notes.push("plan_validity_drift");
  }

  return {
    objectiveId: runA.objectiveId,
    score: roundMetric(Math.max(0, score)),
    comparable: true,
    notes,
  };
}

export function buildOrchestrationSmokeRuns(): OrchestrationEvalResult[] {
  return GOLDEN_OBJECTIVES.map((item, index) => scoreOrchestrationRun({
    objectiveId: item.id,
    planValid: true,
    stepSuccessRate: 1,
    objectiveAchieved: true,
    costCents: 80 + index * 8,
    wallClockMs: 25_000 + index * 2_500,
  }));
}

export function buildOrchestrationEvalScorecard(
  results: OrchestrationEvalResult[],
  reproducibility: OrchestrationReproducibilityResult[] = buildOrchestrationSmokeReproducibility(results),
): OrchestrationEvalScorecard {
  const passed = results.filter((item) => item.passed).length;
  return {
    suite: "orchestration",
    objectiveCount: results.length,
    passRate: passRate(passed, results.length),
    medianStepSuccessRate: roundMetric(median(results.map((item) => item.stepSuccessRate))),
    medianReproducibility: roundMetric(median(reproducibility.map((item) => item.score))),
    medianCostCents: roundMetric(median(results.map((item) => item.costCents)), 2),
    medianWallClockMs: roundMetric(median(results.map((item) => item.wallClockMs)), 0),
    objectives: results,
    reproducibility,
  };
}

export function buildOrchestrationSmokeReproducibility(
  results: OrchestrationEvalResult[],
): OrchestrationReproducibilityResult[] {
  return results.map((run) => {
    const rerun = scoreOrchestrationRun({
      ...run,
      costCents: run.costCents + 5,
      wallClockMs: run.wallClockMs + 1_000,
    });
    return compareOrchestrationReproducibility(run, rerun);
  });
}

export function meetsOrchestrationPassRateThreshold(scorecard: OrchestrationEvalScorecard, threshold: number): boolean {
  return scorecard.passRate >= threshold;
}
