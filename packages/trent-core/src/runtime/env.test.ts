import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Task 1.1 — the standalone environment contract.
 *
 * Measured, not theoretical: with the queue fallback left at its default a 3-step run produced 31
 * worker invocations and emitted `run_done` ten times, while still reporting `completed` and writing
 * nothing to stderr. A CLI shipped without this contract would silently bill ~4x the model calls.
 *
 * Vitest sets NODE_ENV=test, which ALSO disables the fallback (`queue.ts:189`). If these tests ran
 * under that default they would pass without the contract existing at all — a vacuous green. Every
 * test here therefore forces NODE_ENV=production to imitate a compiled binary.
 */

const CLI_ENV_KEYS = [
  "DATABASE_URL",
  "REDIS_URL",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "TRENT_QUEUE_FALLBACK",
  "TRENT_EVAL_SYNC_QUEUE",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
] as const;

let saved: Record<string, string | undefined> = {};

function imitateCompiledBinary(): void {
  saved = {};
  for (const key of [...CLI_ENV_KEYS, "NODE_ENV"]) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  // A shipped binary is not running under vitest.
  process.env.NODE_ENV = "production";
}

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** Runs one orchestration offline and reports how many times each phase actually executed. */
async function runOnceOffline(label: string): Promise<{
  runDoneCount: number;
  stepStartsById: Record<string, number>;
  status: string | undefined;
}> {
  const { store } = await import("@/lib/store");
  const { launchOrchestration } = await import("@/lib/orchestrator");
  const { processJobData } = await import("@/lib/queue");
  const { setRuntimeEvalOverrides, clearRuntimeEvalOverrides } = await import(
    "@/lib/runtime-eval-overrides"
  );
  const { createEvalExecuteSeatModel, createEvalMockCompletion, pickIntegrationOrchestrationObjectives } =
    await import("@/lib/eval-mock-providers");
  const { buildOrchestrationGoldenObjectives } = await import("@/lib/orchestration-eval");
  const { setSemanticRouterEmbedderForTests } = await import("@/lib/semantic-router");

  setSemanticRouterEmbedderForTests(async (texts: string[]) => texts.map(() => Array(384).fill(0.1)));
  setRuntimeEvalOverrides({
    orchestration: {
      createCompletion: createEvalMockCompletion({}),
      executeSeatModelFn: createEvalExecuteSeatModel(),
    },
  });

  try {
    const objective = pickIntegrationOrchestrationObjectives(buildOrchestrationGoldenObjectives())[0];
    const company = await store.createCompany({ name: label, brief: { vision: "env contract test" } });
    const run = await launchOrchestration({
      companyId: company.id,
      objective: objective.objective,
      trigger: "manual",
    });

    for (let i = 0; i < 40; i += 1) {
      const next = (await store.listJobRuns(company.id))
        .filter((j: any) => j.type === "orchestration_step" && j.status === "running")
        .filter((j: any) => j.metadata?.runId === run.id)
        .sort((a: any, b: any) => a.startedAt.localeCompare(b.startedAt))[0];
      if (!next) break;
      await processJobData("orchestration_step", {
        jobRunId: next.id,
        companyId: company.id,
        runId: run.id,
        action: next.metadata.action,
        stepId: next.metadata.stepId,
      } as any);
    }

    // Give any fire-and-forget setTimeout fallback time to land, so a double run is visible.
    await new Promise((resolve) => setTimeout(resolve, 2500));

    const events = await store.listOrchestratorEvents(run.id);
    const persisted = await store.getOrchestratorRun(run.id);
    const stepStartsById: Record<string, number> = {};
    for (const event of events) {
      if (event.kind !== "step_start") continue;
      const id = (event.payload as any)?.step?.id ?? (event as any).stepId ?? "unknown";
      stepStartsById[id] = (stepStartsById[id] ?? 0) + 1;
    }
    return {
      runDoneCount: events.filter((e: any) => e.kind === "run_done").length,
      stepStartsById,
      status: persisted?.status,
    };
  } finally {
    clearRuntimeEvalOverrides();
  }
}

describe("standalone environment contract", () => {
  beforeEach(() => {
    imitateCompiledBinary();
  });

  it("guard: without the contract a compiled binary double-executes, silently", async () => {
    // No contract applied. This asserts the bug is real, so the test below cannot pass vacuously.
    const result = await runOnceOffline("NoContract");
    expect(result.status).toBe("completed"); // the damage is invisible in the status
    expect(result.runDoneCount).toBeGreaterThan(1);
  }, 60_000);

  it("applies the contract so every job executes exactly once", async () => {
    const { applyStandaloneEnv, assertStandaloneEnv } = await import("./env.js");
    applyStandaloneEnv(":memory:");
    assertStandaloneEnv();

    const result = await runOnceOffline("WithContract");

    expect(result.status).toBe("completed");
    expect(result.runDoneCount).toBe(1);
    for (const [stepId, count] of Object.entries(result.stepStartsById)) {
      expect(count, `step ${stepId} started ${count} times`).toBe(1);
    }
  }, 60_000);

  it("assertStandaloneEnv rejects the env that causes double execution", async () => {
    const { applyStandaloneEnv, assertStandaloneEnv } = await import("./env.js");
    applyStandaloneEnv(":memory:");
    delete process.env.TRENT_QUEUE_FALLBACK;
    expect(() => assertStandaloneEnv()).toThrow(/TRENT_QUEUE_FALLBACK/);
  });
});
