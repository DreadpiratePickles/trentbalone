import "@/lib/workbench-providers";
import { store } from "@/lib/store";
import { makeId } from "@/lib/utils";
import {
  buildEvalWorkbenchDeps,
  pickIntegrationWorkbenchObjectives,
} from "@/lib/eval-mock-providers";
import {
  buildWorkbenchGoldenObjectives,
  scoreWorkbenchObjective,
  type WorkbenchEvalResult,
} from "@/lib/workbench-eval-suite";
import { runWorkbenchAgent } from "@/lib/workbench-agent";
import {
  clearRuntimeEvalOverrides,
  setRuntimeEvalOverrides,
} from "@/lib/runtime-eval-overrides";

export async function runWorkbenchIntegrationSuite(options?: {
  forceBrokenBuild?: boolean;
}): Promise<WorkbenchEvalResult[]> {
  setRuntimeEvalOverrides({
    workbench: { forceBrokenBuild: options?.forceBrokenBuild },
  });

  try {
    const objectives = pickIntegrationWorkbenchObjectives(buildWorkbenchGoldenObjectives());
    const results: WorkbenchEvalResult[] = [];
    for (const item of objectives) {
      results.push(await runSingleWorkbenchIntegrationObjective(item, options?.forceBrokenBuild));
    }
    return results;
  } finally {
    clearRuntimeEvalOverrides();
  }
}

async function runSingleWorkbenchIntegrationObjective(
  objective: { id: string; objective: string },
  forceBrokenBuild?: boolean,
): Promise<WorkbenchEvalResult> {
  const startedAt = Date.now();
  const company = await store.createCompany({
    name: `WbEval ${makeId("co")}`,
    brief: { vision: "workbench integration eval" },
  });

  const session = await store.createWorkbenchSession({
    companyId: company.id,
    agentRole: "engineer",
    agentMode: "build",
    provider: "mock_local",
    status: "running",
    objective: objective.objective,
    metadata: {
      networkPolicy: "deny_all",
      allowedHosts: [],
      maxRuntimeSeconds: 1800,
      maxCostCents: 250,
      approvalRequiredFor: [],
      rollbackAvailable: true,
    },
  });

  const deps = buildEvalWorkbenchDeps(
    { id: objective.id, objective: objective.objective, difficulty: "easy" },
    { forceBrokenBuild },
  );

  let verifyPassed = false;
  let attempts = 0;
  let interactionsPass = false;
  let criticPass = false;
  let screenshotNonBlank = false;

  for await (const chunk of runWorkbenchAgent({
    session,
    userMessage: `Build: ${objective.objective}`,
    deps,
  })) {
    if (chunk.type === "verify") {
      attempts += 1;
      verifyPassed = chunk.passed;
      interactionsPass = chunk.checks.some((check) => check.name === "interaction" && check.status === "pass")
        || chunk.checks.some((check) => check.name === "interaction" && check.status === "skip");
      criticPass = chunk.checks.some((check) => check.name === "critic" && check.status === "pass")
        || chunk.checks.some((check) => check.name === "critic" && check.status === "skip");
      screenshotNonBlank = chunk.checks.some((check) => check.name === "screenshot" && check.status === "pass");
    }
  }

  const refreshed = await store.getWorkbenchSession(session.id);
  const costCents = refreshed?.costCents ?? 0;
  const buildClean = !forceBrokenBuild && refreshed?.status === "completed" && verifyPassed;

  return scoreWorkbenchObjective({
    objectiveId: objective.id,
    buildClean,
    interactionsPass: !forceBrokenBuild && interactionsPass,
    criticPass: !forceBrokenBuild && criticPass,
    screenshotNonBlank: !forceBrokenBuild && screenshotNonBlank,
    attempts: Math.max(attempts, 1),
    costCents,
    wallClockMs: Date.now() - startedAt,
  });
}
