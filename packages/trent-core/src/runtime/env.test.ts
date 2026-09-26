import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Task 1.1 — the standalone environment contract.
 *
 * Measured, not theoretical: with the queue fallback left at its default, the app's in-process
 * fallback (`queue.ts` `runFallbackJob`) runs every enqueued job once through `setTimeout`, and the
 * CLI's own drain loop runs every job it reaches while the job is still `running`. Jobs the two
 * overlap on execute twice, the extra executions enqueue more jobs, and the run still reports
 * `completed` with nothing on stderr. A 3-step run produced 31 worker invocations and `run_done` ten
 * times; CI run 36229183545 produced 19 executions of 13 job records and `run_done` ONCE, because
 * there the drain left early and the fallback alone ran the only consolidate job. So `run_done` is
 * not the evidence: the guard asserts on repeated job executions and repeated billed phases.
 *
 * Vitest sets NODE_ENV=test, which ALSO disables the fallback (`queue.ts:203`). If these tests ran
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
  "SKILL_INJECTION_ENABLED",
] as const;

/** Upper bound, from the start of a run, for the fallback to finish: leaves the 60 s budget room to assert. */
const SETTLE_LIMIT_MS = 45_000;
/** With the contract applied nothing should appear late; this is how long we look for it. */
const QUIET_WINDOW_MS = 2_500;

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

type OfflineRunOptions = {
  /**
   * How the harness's drain hands control back between jobs. "eager" lists the next job at once
   * (only microtasks in between); "yielding" lets due timers run first, as a slower drain does
   * (`orchestrator/drain.ts` awaits `control.settle()` there). The fallback's overlap with the drain
   * depends on it: CI run 36229183545 had the yielding shape, the drain leaving after 6 of 13 jobs.
   */
  drain: "eager" | "yielding";
  /**
   * "fallback-drained": wait until every enqueued job's fallback execution has started and finished
   * (bounded by SETTLE_LIMIT_MS), so the counts are final, not a snapshot. "quiet-window": nothing
   * should run after the drain, so look for QUIET_WINDOW_MS for anything that does.
   */
  settle: "fallback-drained" | "quiet-window";
};

type OfflineRun = {
  status: string | undefined;
  runDoneCount: number;
  /** Starts per billed phase from the run's durable event ledger: plan, step:<id>, consolidate, run_done. */
  phaseStarts: Record<string, number>;
  repeatedPhases: string[];
  /** Orchestration job records the run created, and how many executions of them began. */
  jobs: number;
  executions: number;
  repeatedJobs: string[];
  /** Every execution that began has finished and no scheduled fallback execution is outstanding. */
  idle: boolean;
};

/** Runs one orchestration offline and reports, once settled, how many times each job and phase ran. */
async function runOnceOffline(label: string, options: OfflineRunOptions): Promise<OfflineRun> {
  const deadline = Date.now() + SETTLE_LIMIT_MS;
  const { store } = await import("@/lib/store");
  const { launchOrchestration } = await import("@/lib/orchestrator");
  const { processJobData } = await import("@/lib/queue");
  const { subscribeJobEvents } = await import("@/lib/job-events");
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

  const company = await store.createCompany({ name: label, brief: { vision: "env contract test" } });
  // The queue reports every enqueue ("queued", after the fallback timer is set), every execution
  // ("started", whoever runs it) and every execution's end ("completed"/"failed") on this bus.
  const executionsByJob: Record<string, number> = {};
  let queued = 0;
  let started = 0;
  let finished = 0;
  const unsubscribe = subscribeJobEvents((event) => {
    if (event.companyId !== company.id || event.jobRun?.type !== "orchestration_step") return;
    if (event.status === "queued") queued += 1;
    else if (event.status === "started") {
      started += 1;
      executionsByJob[event.jobRunId] = (executionsByJob[event.jobRunId] ?? 0) + 1;
    } else if (event.status === "completed" || event.status === "failed") finished += 1;
  });
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  try {
    const objective = pickIntegrationOrchestrationObjectives(buildOrchestrationGoldenObjectives())[0];
    const run = await launchOrchestration({
      companyId: company.id,
      objective: objective.objective,
      trigger: "manual",
    });

    let drainCalls = 0;
    for (let i = 0; i < 40; i += 1) {
      const next = (await store.listJobRuns(company.id))
        .filter((j: any) => j.type === "orchestration_step" && j.status === "running")
        .filter((j: any) => j.metadata?.runId === run.id)
        .sort((a: any, b: any) => a.startedAt.localeCompare(b.startedAt))[0];
      if (!next) break;
      drainCalls += 1;
      await processJobData("orchestration_step", {
        jobRunId: next.id,
        companyId: company.id,
        runId: run.id,
        action: next.metadata.action,
        stepId: next.metadata.stepId,
      } as any);
      if (options.drain === "yielding") await new Promise((resolve) => setImmediate(resolve));
    }

    // The drain can finish while fallback executions of jobs it already completed are still in
    // flight, and those can enqueue more work. A fixed pause here is what made the guard flaky.
    const fallbackDrained = () => started === drainCalls + queued && finished === started;
    if (options.settle === "fallback-drained") {
      while (!fallbackDrained() && Date.now() < deadline) await sleep(20);
    } else {
      await sleep(QUIET_WINDOW_MS);
    }

    const events = await store.listOrchestratorEvents(run.id);
    const persisted = await store.getOrchestratorRun(run.id);
    const phaseStarts: Record<string, number> = {};
    for (const event of events) {
      const phase =
        event.kind === "plan_start" ? "plan"
        : event.kind === "step_start" ? `step:${(event.payload as any)?.step?.id ?? (event as any).stepId ?? "unknown"}`
        : event.kind === "consolidate_start" ? "consolidate"
        : event.kind === "run_done" ? "run_done"
        : undefined;
      if (phase) phaseStarts[phase] = (phaseStarts[phase] ?? 0) + 1;
    }
    const jobs = (await store.listJobRuns(company.id)).filter(
      (j: any) => j.type === "orchestration_step" && j.metadata?.runId === run.id,
    ).length;
    return {
      status: persisted?.status,
      runDoneCount: phaseStarts.run_done ?? 0,
      phaseStarts,
      repeatedPhases: Object.keys(phaseStarts).filter((phase) => phaseStarts[phase] > 1),
      jobs,
      executions: started,
      repeatedJobs: Object.keys(executionsByJob).filter((id) => executionsByJob[id] > 1),
      idle: finished === started && (options.settle === "quiet-window" || fallbackDrained()),
    };
  } finally {
    unsubscribe();
    clearRuntimeEvalOverrides();
  }
}

/** The settled record, for assertion messages. */
function describeRun(result: OfflineRun): string {
  const { jobs, executions, idle, phaseStarts } = result;
  return JSON.stringify({ jobs, executions, idle, phaseStarts });
}

describe("standalone environment contract", () => {
  beforeEach(() => {
    imitateCompiledBinary();
  });

  // No contract applied. These assert the bug is real, so the contract test cannot pass vacuously:
  // they measure exactly what it bounds (job executions, phase starts). `run_done > 1` is NOT the
  // evidence: it counts consolidate executions, which were 1 in CI run 36229183545.
  it("guard: without the contract a compiled binary double-executes, silently", async () => {
    const result = await runOnceOffline("NoContract", { drain: "eager", settle: "fallback-drained" });
    expect(result.status).toBe("completed"); // the damage is invisible in the status
    expect(result.repeatedJobs.length, describeRun(result)).toBeGreaterThan(0);
    expect(result.executions, describeRun(result)).toBeGreaterThan(result.jobs);
    expect(result.repeatedPhases.length, describeRun(result)).toBeGreaterThan(0);
  }, 60_000);

  it("guard: the double execution holds when the drain yields between jobs (the CI 36229183545 shape)", async () => {
    const result = await runOnceOffline("NoContractYielding", { drain: "yielding", settle: "fallback-drained" });
    expect(result.status).toBe("completed");
    expect(result.repeatedJobs.length, describeRun(result)).toBeGreaterThan(0);
    expect(result.executions, describeRun(result)).toBeGreaterThan(result.jobs);
    expect(result.repeatedPhases.length, describeRun(result)).toBeGreaterThan(0);
  }, 60_000);

  it("applies the contract so every job executes exactly once", async () => {
    const { applyStandaloneEnv, assertStandaloneEnv } = await import("./env.js");
    applyStandaloneEnv(":memory:");
    assertStandaloneEnv();

    const result = await runOnceOffline("WithContract", { drain: "eager", settle: "quiet-window" });

    expect(result.status).toBe("completed");
    expect(result.runDoneCount).toBe(1);
    expect(result.idle, describeRun(result)).toBe(true);
    expect(result.repeatedJobs, describeRun(result)).toEqual([]);
    expect(result.executions, describeRun(result)).toBe(result.jobs);
    for (const [phase, count] of Object.entries(result.phaseStarts)) {
      expect(count, `${phase} started ${count} times`).toBe(1);
    }
  }, 60_000);

  it("I.17: applyStandaloneEnv turns skill injection on, so a promoted skill can reach the seat that earned it", async () => {
    const { applyStandaloneEnv, standaloneEnvKeys } = await import("./env.js");
    expect(process.env.SKILL_INJECTION_ENABLED).toBeUndefined();
    applyStandaloneEnv(":memory:");
    expect(process.env.SKILL_INJECTION_ENABLED).toBe("1");
    expect(standaloneEnvKeys()).toContain("SKILL_INJECTION_ENABLED");
  });

  it("assertStandaloneEnv rejects the env that causes double execution", async () => {
    const { applyStandaloneEnv, assertStandaloneEnv } = await import("./env.js");
    applyStandaloneEnv(":memory:");
    delete process.env.TRENT_QUEUE_FALLBACK;
    expect(() => assertStandaloneEnv()).toThrow(/TRENT_QUEUE_FALLBACK/);
  });
});
