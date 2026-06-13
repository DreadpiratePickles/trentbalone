/**
 * Mock-provider soak executor (PARITY-PLAN P5 instrument, credential-free).
 *
 * Runs one workbench objective headless through runWorkbenchAgent with the
 * eval mock provider, N times, capturing the same verify signals the eval
 * suite scores. `brokenEvery` injects controlled flakiness so the instrument
 * itself is provable (a soak that can only ever report 20/20 measures
 * nothing). The real E2B/Daytona soak is the credentialed follow-up that swaps
 * this executor for a live provider.
 */
import { store } from "@/lib/store";
import { makeId } from "@/lib/utils";
import { runWorkbenchAgent } from "@/lib/workbench-agent";
import { buildEvalWorkbenchDeps } from "@/lib/eval-mock-providers";
import { scoreWorkbenchObjective, type WorkbenchGoldenObjective } from "@/lib/workbench-eval-suite";
import { runWorkbenchSoak, type SoakReport, type SoakRunOutcome } from "@/lib/workbench-soak";

export async function runMockWorkbenchSoakIteration(
  objective: WorkbenchGoldenObjective,
  options?: { forceBrokenBuild?: boolean },
): Promise<SoakRunOutcome> {
  const startedAt = Date.now();
  const company = await store.createCompany({
    name: `Soak ${makeId("co")}`,
    brief: { vision: "workbench soak" },
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

  const deps = buildEvalWorkbenchDeps(objective, { forceBrokenBuild: options?.forceBrokenBuild });

  let attempts = 0;
  let buildClean = false;
  let interactionsPass = false;
  let criticPass = false;
  let screenshotNonBlank = false;
  for await (const chunk of runWorkbenchAgent({ session, userMessage: `Build: ${objective.objective}`, deps })) {
    if (chunk.type === "verify") {
      attempts += 1;
      buildClean = chunk.passed;
      interactionsPass = chunk.checks.some((c) => c.name === "interaction" && (c.status === "pass" || c.status === "skip"));
      criticPass = chunk.checks.some((c) => c.name === "critic" && (c.status === "pass" || c.status === "skip"));
      screenshotNonBlank = chunk.checks.some((c) => c.name === "screenshot" && c.status === "pass");
    }
  }

  const scored = scoreWorkbenchObjective({
    objectiveId: objective.id,
    buildClean,
    interactionsPass,
    criticPass,
    screenshotNonBlank,
    attempts: attempts || 1,
    costCents: 0,
    wallClockMs: Date.now() - startedAt,
  });
  return {
    passed: scored.passed,
    failureTags: scored.failureTags,
    attempts: scored.attempts,
    wallClockMs: scored.wallClockMs,
  };
}

/** Soak one objective N times on the mock provider; brokenEvery=k fails every k-th run. */
export async function runMockWorkbenchSoak(input: {
  objective: WorkbenchGoldenObjective;
  iterations: number;
  threshold?: number;
  brokenEvery?: number;
}): Promise<SoakReport> {
  return runWorkbenchSoak({
    objectiveId: input.objective.id,
    iterations: input.iterations,
    threshold: input.threshold,
    runOnce: (iteration) =>
      runMockWorkbenchSoakIteration(input.objective, {
        forceBrokenBuild: input.brokenEvery ? (iteration + 1) % input.brokenEvery === 0 : false,
      }),
  });
}
