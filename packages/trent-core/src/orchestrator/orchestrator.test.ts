import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { OrcEvent, OrchestrationRunSnapshot } from "./types.js";

/**
 * Task 1.6 — the orchestrator wrapper and its owned drain loop.
 *
 * `apps/web/lib/orchestrator.ts` has no `runOrchestration()`. `launchOrchestration()` only ENQUEUES
 * a plan job; nothing outside the eval harness drains the queue. These tests pin the single-call
 * abstraction the CLI needs: an async-iterable handle over the 20-kind in-process event bus, a
 * bounded drain loop, and cancellation.
 *
 * Offline setup (mock providers + semantic-router stub + NODE_ENV=production) is the proven pattern
 * from `../runtime/env.test.ts`. NODE_ENV matters: vitest's default `test` value ALSO disables the
 * queue fallback, so the run-done-exactly-once assertion would pass vacuously under it.
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

type OfflineHarness = {
  companyId: string;
  objective: string;
  createCompletion: (...args: never[]) => unknown;
  executeSeatModelFn: (...args: never[]) => unknown;
};

/**
 * Boots the offline providers and a fresh company. `applyStandaloneEnv` runs FIRST because
 * `ai-client.ts` freezes its model registry and token limits at module-evaluation time, so any
 * apps/web import before it would capture the wrong environment.
 */
async function bootOffline(label: string): Promise<OfflineHarness> {
  const { applyStandaloneEnv, IN_MEMORY_DATABASE } = await import("../runtime/env.js");
  applyStandaloneEnv(IN_MEMORY_DATABASE);

  const { store } = await import("@/lib/store");
  const { createEvalExecuteSeatModel, createEvalMockCompletion, pickIntegrationOrchestrationObjectives } =
    await import("@/lib/eval-mock-providers");
  const { buildOrchestrationGoldenObjectives } = await import("@/lib/orchestration-eval");
  const { setSemanticRouterEmbedderForTests } = await import("@/lib/semantic-router");

  setSemanticRouterEmbedderForTests(async (texts: string[]) => texts.map(() => Array(384).fill(0.1)));

  const objective = pickIntegrationOrchestrationObjectives(buildOrchestrationGoldenObjectives())[0]!.objective;
  const company = await store.createCompany({ name: label, brief: { vision: "orchestrator wrapper test" } });

  return {
    companyId: company.id,
    objective,
    createCompletion: createEvalMockCompletion({}) as unknown as (...args: never[]) => unknown,
    executeSeatModelFn: createEvalExecuteSeatModel() as unknown as (...args: never[]) => unknown,
  };
}

describe("orchestrator wrapper — one full offline run", () => {
  let events: OrcEvent[] = [];
  let traced: OrcEvent[] = [];
  let snapshot: OrchestrationRunSnapshot;
  let sawStepStartBeforeResult = false;

  beforeAll(async () => {
    imitateCompiledBinary();

    const harness = await bootOffline("OrcWrapperFull");
    const { createOrchestrator } = await import("./index.js");
    const orchestrator = createOrchestrator({
      createCompletion: harness.createCompletion,
      executeSeatModelFn: harness.executeSeatModelFn,
      traceSink: (event) => traced.push(event),
    });

    const handle = orchestrator.run({ companyId: harness.companyId, objective: harness.objective });
    let resultSettled = false;
    const resultPromise = handle.result().then((value) => {
      resultSettled = true;
      return value;
    });

    for await (const event of handle) {
      events.push(event);
      if (event.kind === "step_start" && !resultSettled) sawStepStartBeforeResult = true;
    }
    snapshot = await resultPromise;

    // Let any fire-and-forget fallback land, so a duplicate run_done would be visible.
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }, 120_000);

  afterAll(() => {
    restoreEnv();
  });

  it("reaches a terminal state with a real multi-agent plan", () => {
    expect(snapshot.status).toBe("completed");
    expect(snapshot.steps.length).toBeGreaterThanOrEqual(3);
    const roles = new Set(snapshot.steps.map((step) => step.agentRole));
    expect(roles.size, `distinct agent roles: ${[...roles].join(", ")}`).toBeGreaterThan(1);
  });

  it("emits the phase sequence the CLI renders", () => {
    const kinds = events.map((event) => event.kind);
    for (const required of ["plan_end", "step_start", "step_end", "consolidate_end"] as const) {
      expect(kinds, `missing ${required}`).toContain(required);
    }
    expect(kinds.indexOf("plan_end")).toBeLessThan(kinds.indexOf("step_start"));
    expect(kinds.indexOf("step_end")).toBeLessThan(kinds.indexOf("consolidate_end"));
  });

  it("emits run_done exactly once (duplicate-execution regression guard)", () => {
    expect(events.filter((event) => event.kind === "run_done")).toHaveLength(1);
  });

  it("yields events live, before result() resolves", () => {
    expect(sawStepStartBeforeResult).toBe(true);
  });

  it("delivers every iterated event to the injected traceSink", () => {
    expect(traced.length).toBeGreaterThan(0);
    const tracedKeys = new Set(traced.map((event) => `${event.kind}|${event.at}|${event.step?.id ?? ""}`));
    for (const event of events) {
      expect(tracedKeys).toContain(`${event.kind}|${event.at}|${event.step?.id ?? ""}`);
    }
  });
});

describe("orchestrator wrapper — interruption", () => {
  beforeAll(() => {
    imitateCompiledBinary();
  });
  afterAll(() => {
    restoreEnv();
  });

  it("cancel() stops a running handle and the run never completes", async () => {
    const harness = await bootOffline("OrcWrapperCancel");
    const { createOrchestrator } = await import("./index.js");
    const orchestrator = createOrchestrator({
      createCompletion: harness.createCompletion,
      executeSeatModelFn: harness.executeSeatModelFn,
    });

    const handle = orchestrator.run({ companyId: harness.companyId, objective: harness.objective });
    let cancelled: boolean | undefined;
    for await (const event of handle) {
      if (event.kind === "step_start" && cancelled === undefined) cancelled = await handle.cancel();
    }
    const snapshot = await handle.result();

    expect(cancelled).toBe(true);
    expect(snapshot.status).toBe("cancelled");
    expect(snapshot.status).not.toBe("completed");
  }, 120_000);

  it("options.signal aborts the drain loop without killing the process", async () => {
    const harness = await bootOffline("OrcWrapperAbort");
    const { createOrchestrator } = await import("./index.js");
    const orchestrator = createOrchestrator({
      createCompletion: harness.createCompletion,
      executeSeatModelFn: harness.executeSeatModelFn,
    });
    const controller = new AbortController();

    const handle = orchestrator.run({
      companyId: harness.companyId,
      objective: harness.objective,
      signal: controller.signal,
    });
    for await (const event of handle) {
      if (event.kind === "step_start") controller.abort();
    }
    const snapshot = await handle.result();

    expect(snapshot.status).not.toBe("completed");
    // The process survived: a second call still works.
    expect(await orchestrator.snapshot(handle.runId)).toBeDefined();
  }, 120_000);

  it("maxJobs bounds the drain loop instead of hanging", async () => {
    const harness = await bootOffline("OrcWrapperMaxJobs");
    const { createOrchestrator } = await import("./index.js");
    const orchestrator = createOrchestrator({
      createCompletion: harness.createCompletion,
      executeSeatModelFn: harness.executeSeatModelFn,
    });

    const handle = orchestrator.run({
      companyId: harness.companyId,
      objective: harness.objective,
      maxJobs: 1,
    });
    const kinds: string[] = [];
    for await (const event of handle) kinds.push(event.kind);
    const snapshot = await handle.result();

    expect(kinds).toContain("plan_end");
    expect(kinds).not.toContain("consolidate_end");
    expect(snapshot.status).not.toBe("completed");
  }, 60_000);
});
