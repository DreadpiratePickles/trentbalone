import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { OrcEvent } from "./types.js";

/**
 * T3.5 — the per-profile concurrent-run cap (`runtime.max_concurrent_runs`, default 2).
 *
 * `run()` takes a slot BEFORE `launchOrchestration`, so a queued run has no row, no `run_start`
 * and no drain loop until a running one settles. The wait is FIFO and announced once with a
 * `heartbeat` event whose detail says how many runs are ahead. A run parked on an approval still
 * holds its slot: a parked run is a run.
 *
 * Offline setup is the proven pattern from `orchestrator.test.ts`: the eval mock providers plus
 * `NODE_ENV=production`. The planner port is gated per call, so a run holds its slot until the
 * test lets its plan job through; `maxJobs: 1` ends each run right after that job.
 */

const ENV_KEYS = [
  "NODE_ENV",
  "DATABASE_URL",
  "REDIS_URL",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "TRENT_QUEUE_FALLBACK",
  "TRENT_EVAL_SYNC_QUEUE",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
] as const;

const savedEnv: Record<string, string | undefined> = {};

function imitateCompiledBinary(): void {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.NODE_ENV = "production";
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

type Port = (...args: never[]) => unknown;

interface Harness {
  companyId: string;
  objective: string;
  createCompletion: Port;
  executeSeatModelFn: Port;
  /** Resolvers for planner calls that are waiting on the gate, oldest first. */
  gated: Array<() => void>;
  /** Resolves once at least `count` planner calls are waiting. */
  waitForGated(count: number): Promise<void>;
}

async function bootOffline(label: string): Promise<Harness> {
  const { applyStandaloneEnv, IN_MEMORY_DATABASE } = await import("../runtime/env.js");
  applyStandaloneEnv(IN_MEMORY_DATABASE);

  const { store } = await import("@/lib/store");
  const { createEvalExecuteSeatModel, createEvalMockCompletion, pickIntegrationOrchestrationObjectives } =
    await import("@/lib/eval-mock-providers");
  const { buildOrchestrationGoldenObjectives } = await import("@/lib/orchestration-eval");
  const { setSemanticRouterEmbedderForTests } = await import("@/lib/semantic-router");
  setSemanticRouterEmbedderForTests(async (texts: string[]) => texts.map(() => Array(384).fill(0.1)));

  const objective = pickIntegrationOrchestrationObjectives(buildOrchestrationGoldenObjectives())[0]!.objective;
  const company = await store.createCompany({ name: label, brief: { vision: "concurrency cap test" } });

  const mock = createEvalMockCompletion({}) as unknown as (...args: unknown[]) => unknown;
  const gated: Array<() => void> = [];
  const gatedCompletion = async (...args: unknown[]): Promise<unknown> => {
    await new Promise<void>((resolve) => gated.push(resolve));
    return mock(...args);
  };
  return {
    companyId: company.id,
    objective,
    createCompletion: gatedCompletion as unknown as Port,
    executeSeatModelFn: createEvalExecuteSeatModel() as unknown as Port,
    gated,
    waitForGated: async (count) => {
      for (let i = 0; i < 200 && gated.length < count; i += 1) await tick(25);
      if (gated.length < count) throw new Error(`only ${gated.length} planner call(s) reached the gate, wanted ${count}`);
    },
  };
}

function tick(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("orchestrator wrapper — per-profile concurrent-run cap", () => {
  beforeAll(imitateCompiledBinary);
  afterAll(restoreEnv);

  it("with cap 2 the third run() waits for a slot, announces the wait once, and launches when one finishes", async () => {
    const harness = await bootOffline("OrcCapTwo");
    const { createOrchestrator } = await import("./index.js");
    const traced: OrcEvent[] = [];
    const orchestrator = createOrchestrator({
      createCompletion: harness.createCompletion,
      executeSeatModelFn: harness.executeSeatModelFn,
      maxJobs: 1,
      maxConcurrentRuns: 2,
      traceSink: (event) => traced.push(event),
    });
    const options = { companyId: harness.companyId, objective: harness.objective };

    const first = orchestrator.run(options);
    const second = orchestrator.run(options);
    const third = orchestrator.run(options);
    const order: string[] = [];
    void third.started.then(() => order.push("third started"));
    const results = [first, second].map((handle, index) => handle.result().then(() => order.push(`run ${index + 1} done`)));

    await Promise.all([first.started, second.started]);
    await harness.waitForGated(2);
    await tick();
    expect(order).toEqual([]);
    expect(traced.filter((event) => event.kind === "run_start")).toHaveLength(2);

    const queued = traced.filter((event) => event.kind === "heartbeat" && /queued/.test(event.detail ?? ""));
    expect(queued).toHaveLength(1);
    expect(queued[0]?.detail).toContain("queued: 2 ahead");

    // Let exactly one plan job through: one run finishes and hands its slot to the third.
    harness.gated.shift()?.();
    await Promise.race(results);
    await third.started;
    expect(order[0]).toMatch(/^run [12] done$/);
    expect(order).toContain("third started");
    expect(order.indexOf("third started")).toBeGreaterThan(0);

    await harness.waitForGated(2);
    while (harness.gated.length > 0) harness.gated.shift()?.();
    await Promise.all([...results, third.result()]);
    expect(traced.filter((event) => event.kind === "run_start")).toHaveLength(3);
    expect(traced.filter((event) => event.kind === "heartbeat" && /queued/.test(event.detail ?? ""))).toHaveLength(1);
  }, 120_000);

  it("cap 1 serialises: the second run does not launch until the first has settled", async () => {
    const harness = await bootOffline("OrcCapOne");
    const { createOrchestrator } = await import("./index.js");
    const traced: OrcEvent[] = [];
    const orchestrator = createOrchestrator({
      createCompletion: harness.createCompletion,
      executeSeatModelFn: harness.executeSeatModelFn,
      maxJobs: 1,
      maxConcurrentRuns: 1,
      traceSink: (event) => traced.push(event),
    });
    const options = { companyId: harness.companyId, objective: harness.objective };

    const first = orchestrator.run(options);
    const second = orchestrator.run(options);
    const order: string[] = [];
    void second.started.then(() => order.push("second started"));
    const firstDone = first.result().then(() => order.push("first done"));

    await first.started;
    await harness.waitForGated(1);
    await tick();
    expect(order).toEqual([]);
    expect(traced.filter((event) => event.kind === "run_start")).toHaveLength(1);
    expect(traced.find((event) => event.kind === "heartbeat")?.detail).toContain("queued: 1 ahead");

    harness.gated.shift()?.();
    await firstDone;
    await second.started;
    expect(order).toEqual(["first done", "second started"]);

    await harness.waitForGated(1);
    harness.gated.shift()?.();
    await second.result();
    expect(traced.filter((event) => event.kind === "run_start")).toHaveLength(2);
  }, 120_000);
});
