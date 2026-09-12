import { afterEach, describe, expect, it, vi } from "vitest";
import type { StepRecord } from "@/lib/orchestrator-runtime";
import {
  getOrcMaxConcurrency,
  runOrchestrationDagPool,
  selectReadyStepsForEnqueue,
} from "@/lib/orchestrator";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function baseStep(overrides: Partial<StepRecord> & Pick<StepRecord, "id">): StepRecord {
  return {
    title: overrides.id,
    rationale: "test",
    agentRole: "engineer",
    dependsOn: [],
    expectedOutput: "output",
    riskLevel: "low",
    needsApproval: false,
    status: "pending",
    ...overrides,
  };
}

describe("orchestration DAG concurrency", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("runs two independent steps with overlapping start/finish timestamps", async () => {
    const steps: StepRecord[] = [
      baseStep({ id: "a", agentRole: "analyst" }),
      baseStep({ id: "b", agentRole: "content" }),
    ];
    const timestamps = new Map<string, { start: number; end: number }>();

    await runOrchestrationDagPool(steps, async (step) => {
      const start = Date.now();
      timestamps.set(step.id, { start, end: start });
      await sleep(40);
      step.status = "completed";
      step.output = `done:${step.id}`;
      step.completedAt = new Date().toISOString();
      timestamps.get(step.id)!.end = Date.now();
    });

    const a = timestamps.get("a")!;
    const b = timestamps.get("b")!;
    expect(a.start).toBeLessThan(b.end);
    expect(b.start).toBeLessThan(a.end);
    expect(steps.every((step) => step.status === "completed")).toBe(true);
  });

  it("starts a dependent step only after its dependency completes", async () => {
    const steps: StepRecord[] = [
      baseStep({ id: "s1", agentRole: "ceo" }),
      baseStep({ id: "s2", agentRole: "engineer", dependsOn: ["s1"] }),
    ];
    const timestamps = new Map<string, { start: number; end: number }>();

    await runOrchestrationDagPool(steps, async (step) => {
      const start = Date.now();
      timestamps.set(step.id, { start, end: start });
      await sleep(step.id === "s1" ? 30 : 10);
      step.status = "completed";
      step.output = `done:${step.id}`;
      step.completedAt = new Date().toISOString();
      timestamps.get(step.id)!.end = Date.now();
    });

    const s1 = timestamps.get("s1")!;
    const s2 = timestamps.get("s2")!;
    expect(s2.start).toBeGreaterThanOrEqual(s1.end);
  });

  it("honors ORC_MAX_CONCURRENCY when selecting ready steps", () => {
    vi.stubEnv("ORC_MAX_CONCURRENCY", "2");
    const steps: StepRecord[] = [
      baseStep({ id: "a" }),
      baseStep({ id: "b" }),
      baseStep({ id: "c" }),
      baseStep({ id: "d" }),
    ];

    const firstWave = selectReadyStepsForEnqueue(steps);
    expect(firstWave.map((step) => step.id)).toEqual(["a", "b"]);
    expect(getOrcMaxConcurrency()).toBe(2);
  });

  it("caps in-flight execution in the DAG pool", async () => {
    const steps: StepRecord[] = [
      baseStep({ id: "a" }),
      baseStep({ id: "b" }),
      baseStep({ id: "c" }),
      baseStep({ id: "d" }),
      baseStep({ id: "e" }),
    ];
    let inFlight = 0;
    let maxInFlight = 0;

    await runOrchestrationDagPool(
      steps,
      async (step) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await sleep(25);
        step.status = "completed";
        step.output = `done:${step.id}`;
        step.completedAt = new Date().toISOString();
        inFlight -= 1;
      },
      { maxConcurrency: 2 },
    );

    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBe(2);
    expect(steps.every((step) => step.status === "completed")).toBe(true);
  });
});
