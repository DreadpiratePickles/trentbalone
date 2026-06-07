import { store } from "@/lib/store";
import { makeId } from "@/lib/utils";
import {
  createEvalExecuteSeatModel,
  createEvalMockCompletion,
  pickIntegrationOrchestrationObjectives,
} from "@/lib/eval-mock-providers";
import {
  buildOrchestrationGoldenObjectives,
  scoreOrchestrationRun,
  validateOrchestrationPlanDag,
  type OrchestrationEvalResult,
} from "@/lib/orchestration-eval";
import { launchOrchestration } from "@/lib/orchestrator";
import { deleteCachedOrchestrationRun } from "@/lib/orchestrator-cache";
import type { OrchestrationStep } from "@/lib/orchestrator-runtime";
import {
  clearRuntimeEvalOverrides,
  setRuntimeEvalOverrides,
} from "@/lib/runtime-eval-overrides";
import { processJobData } from "@/lib/queue";
import { setSemanticRouterEmbedderForTests, resetSemanticRouterForTests } from "@/lib/semantic-router";

export async function runOrchestrationIntegrationSuite(options?: {
  forceBrokenPlanner?: boolean;
  forceBrokenExecution?: boolean;
}): Promise<OrchestrationEvalResult[]> {
  const previousRedis = process.env.REDIS_URL;
  const previousFallback = process.env.TRENT_QUEUE_FALLBACK;
  const previousApiKey = process.env.OPENAI_API_KEY;
  process.env.REDIS_URL = "";
  process.env.TRENT_QUEUE_FALLBACK = "disabled";
  delete process.env.OPENAI_API_KEY;

  setSemanticRouterEmbedderForTests(async (texts) => texts.map(() => Array(384).fill(0.1)));
  setRuntimeEvalOverrides({
    orchestration: {
      createCompletion: createEvalMockCompletion({ forceBrokenPlanner: options?.forceBrokenPlanner }),
      executeSeatModelFn: createEvalExecuteSeatModel(),
      forceBrokenPlanner: options?.forceBrokenPlanner,
      forceBrokenExecution: options?.forceBrokenExecution,
    },
  });

  try {
    const objectives = pickIntegrationOrchestrationObjectives(buildOrchestrationGoldenObjectives());
    const results: OrchestrationEvalResult[] = [];
    for (const item of objectives) {
      results.push(await runSingleOrchestrationIntegrationObjective(item.objective, item.id));
    }
    return results;
  } finally {
    clearRuntimeEvalOverrides();
    resetSemanticRouterForTests();
    setSemanticRouterEmbedderForTests(null);
    if (previousRedis === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = previousRedis;
    if (previousFallback === undefined) delete process.env.TRENT_QUEUE_FALLBACK;
    else process.env.TRENT_QUEUE_FALLBACK = previousFallback;
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
  }
}

async function runSingleOrchestrationIntegrationObjective(
  objective: string,
  objectiveId: string,
): Promise<OrchestrationEvalResult> {
  const startedAt = Date.now();
  const company = await store.createCompany({
    name: `OrcEval ${makeId("co")}`,
    brief: { vision: "integration eval" },
  });

  const run = await launchOrchestration({
    companyId: company.id,
    objective,
    trigger: "manual",
  });

  await drainOrchestrationRun(company.id, run.id);

  deleteCachedOrchestrationRun(run.id);
  const persisted = await store.getOrchestratorRun(run.id);
  const steps = await store.listOrchestratorSteps(run.id);
  const completed = steps.filter((step) => step.status === "completed").length;
  const actionable = steps.filter((step) => step.status !== "blocked").length;
  const planSteps: OrchestrationStep[] = steps.map((step) => ({
    id: step.id,
    title: step.title,
    rationale: step.rationale,
    agentRole: step.agentRole,
    dependsOn: step.dependsOn,
    expectedOutput: step.expectedOutput,
    riskLevel: step.riskLevel as OrchestrationStep["riskLevel"],
    needsApproval: step.needsApproval,
  }));
  const dag = validateOrchestrationPlanDag(planSteps);
  const stepSuccessRate = actionable > 0 ? completed / actionable : 0;
  const costCents = steps.reduce((total, step) => total + (step.costCents ?? 0), 0);

  return scoreOrchestrationRun({
    objectiveId,
    planValid: dag.valid && steps.length >= 3,
    stepSuccessRate,
    objectiveAchieved: persisted?.status === "completed" && Boolean(persisted.summary),
    costCents,
    wallClockMs: Date.now() - startedAt,
  });
}

async function drainOrchestrationRun(companyId: string, runId: string, maxJobs = 30): Promise<void> {
  for (let i = 0; i < maxJobs; i += 1) {
    const jobs = (await store.listJobRuns(companyId))
      .filter((job) => job.type === "orchestration_step" && job.status === "running")
      .filter((job) => job.metadata?.runId === runId)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));

    const next = jobs[0];
    if (!next) return;

    await processJobData("orchestration_step", {
      jobRunId: next.id,
      companyId,
      runId,
      action: next.metadata.action as "plan" | "execute_step" | "consolidate",
      stepId: next.metadata.stepId as string | undefined,
    });
  }
}
