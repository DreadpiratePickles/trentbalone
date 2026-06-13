import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "@/lib/store";
import { makeId } from "@/lib/utils";
import type { OrchestrationPlan } from "@/lib/orchestrator-runtime";

const executionCounts = vi.hoisted(() => new Map<string, number>());

const mockSpend = vi.hoisted(() => ({
  assertSpendAvailable: vi.fn().mockResolvedValue(undefined),
  assertAgentTokenBudget: vi.fn().mockResolvedValue(undefined),
}));

const threeStepPlan = vi.hoisted((): OrchestrationPlan => ({
  objective: "Ship a durable checklist",
  reasoning: "test plan",
  steps: [
    {
      id: "s1",
      title: "Scope objective",
      rationale: "Define done",
      agentRole: "ceo",
      dependsOn: [],
      expectedOutput: "Success definition",
      riskLevel: "low",
      needsApproval: false,
    },
    {
      id: "s2",
      title: "Execute primary workstream",
      rationale: "Deliverable",
      agentRole: "engineer",
      dependsOn: ["s1"],
      expectedOutput: "First-pass deliverable",
      riskLevel: "medium",
      needsApproval: false,
    },
    {
      id: "s3",
      title: "Consolidate",
      rationale: "Wrap up",
      agentRole: "ceo",
      dependsOn: ["s2"],
      expectedOutput: "Summary",
      riskLevel: "low",
      needsApproval: false,
    },
  ],
  successCriteria: ["Deliverable produced"],
  blockers: [],
}));

const approvalPlan = vi.hoisted((): OrchestrationPlan => ({
  ...threeStepPlan,
  steps: threeStepPlan.steps.map((step) =>
    step.id === "s2" ? { ...step, needsApproval: true } : step,
  ),
}));

vi.mock("@/lib/spend", () => mockSpend);

vi.mock("@/lib/agent-runtime", () => ({
  getAgentRuntime: vi.fn().mockResolvedValue({
    role: "ceo",
    slotContract: { mission: "coordinate" },
    profile: undefined,
    v3Profile: undefined,
    environment: { tools: [], approvalRequiredFor: [], budgetCentsPerRun: 50 },
    systemPrompt: "SYS",
  }),
}));

vi.mock("@/lib/ai", () => ({
  executeAgentRole: vi.fn().mockResolvedValue({
    output: "done",
    model: "fallback",
    tokens: 10,
    costCents: 0,
  }),
  ceoChatResponse: vi.fn().mockResolvedValue({ suggestions: [] }),
}));

vi.mock("@/lib/memory-tiers", () => ({
  writeEpisodicMemory: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/orchestrator-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/orchestrator-runtime")>();
  return {
    ...actual,
    generateOrchestrationPlan: vi.fn().mockResolvedValue(threeStepPlan),
    executeStepWithRuntime: vi.fn().mockImplementation(async ({ step }) => {
      executionCounts.set(step.id, (executionCounts.get(step.id) ?? 0) + 1);
      return {
        output: `output:${step.id}`,
        model: "test-model",
        tokens: 5,
        costCents: 1,
        toolCalls: [],
        workRequests: [],
        execution: {
          id: makeId("exec"),
          companyId: "company",
          cycleId: "cycle",
          agentRole: step.agentRole,
          status: "completed",
          summary: `output:${step.id}`,
          startedAt: new Date().toISOString(),
        },
      };
    }),
    critiqueStepOutput: vi.fn().mockResolvedValue({ verdict: "pass", reason: "ok" }),
    consolidateRun: vi.fn().mockResolvedValue("Run consolidated"),
  };
});

const { processJobData } = await import("@/lib/queue");
const { requeueRunningOrchestrationJobs } = await import("@/lib/queue");
const { launchOrchestration, approveStep, getOrchestrationRun } = await import("@/lib/orchestrator");
const { critiqueStepOutput, executeStepWithRuntime, generateOrchestrationPlan } = await import("@/lib/orchestrator-runtime");

async function drainOrchestrationQueue(companyId: string, runId: string, maxJobs = 20) {
  for (let i = 0; i < maxJobs; i += 1) {
    const jobs = (await store.listJobRuns(companyId))
      .filter((job) => job.type === "orchestration_step" && job.status === "running")
      .filter((job) => job.metadata?.runId === runId)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));

    const next = jobs[0];
    if (!next) break;

    await processJobData("orchestration_step", {
      jobRunId: next.id,
      companyId: next.companyId!,
      runId: next.metadata.runId as string,
      action: next.metadata.action as "plan" | "execute_step" | "consolidate",
      stepId: next.metadata.stepId as string | undefined,
    });
  }
}

describe("durable orchestration runs", () => {
  let companyId: string;

  beforeEach(async () => {
    executionCounts.clear();
    vi.mocked(generateOrchestrationPlan).mockResolvedValue(threeStepPlan);
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("OPENAI_BASE_URL", "");
    const company = await store.createCompany({
      name: `Durable Run ${makeId("test")}`,
      brief: { vision: "queue-backed orchestration" },
    });
    companyId = company.id;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resumes from the last completed step after a worker restart without duplicating work", async () => {
    const run = await launchOrchestration({
      companyId,
      objective: "Ship a durable checklist",
      trigger: "manual",
    });

    await drainOrchestrationQueue(companyId, run.id, 2);
    expect(executionCounts.get("s1")).toBe(1);
    expect(executionCounts.get("s2")).toBeUndefined();

    const interruptedJobs = (await store.listJobRuns(companyId))
      .filter((job) => job.type === "orchestration_step" && job.metadata?.runId === run.id);
    const stepTwoJob = interruptedJobs.find((job) => job.metadata?.stepId === "s2");
    expect(stepTwoJob).toBeTruthy();

    const addJob = vi.fn().mockResolvedValue(undefined);
    const result = await requeueRunningOrchestrationJobs({ companyId, addJob });
    expect(result.requeued).toBeGreaterThanOrEqual(1);

    runsCacheClear(run.id);
    await drainOrchestrationQueue(companyId, run.id, 10);

    expect(executionCounts.get("s1")).toBe(1);
    expect(executionCounts.get("s2")).toBe(1);
    expect(executionCounts.get("s3")).toBe(1);

    const persisted = await store.getOrchestratorRun(run.id);
    const steps = await store.listOrchestratorSteps(run.id);
    expect(persisted?.status).toBe("completed");
    expect(steps.filter((step) => step.status === "completed").length).toBe(3);
    expect(getOrchestrationRun(run.id)?.status ?? persisted?.status).toBe("completed");
  });

  it("resumes after restart when a paused approval is later approved", async () => {
    vi.mocked(generateOrchestrationPlan).mockResolvedValue(approvalPlan);

    const run = await launchOrchestration({
      companyId,
      objective: "Deploy with approval",
      trigger: "manual",
    });

    await drainOrchestrationQueue(companyId, run.id, 3);
    expect(executionCounts.get("s1")).toBe(1);
    expect(executionCounts.get("s2")).toBeUndefined();

    const awaiting = (await store.listOrchestratorSteps(run.id)).find((step) => step.id === "s2");
    expect(awaiting?.status).toBe("awaiting_approval");
    expect((await store.getOrchestratorRun(run.id))?.status).toBe("awaiting_approval");

    runsCacheClear(run.id);
    await approveStep(run.id, "s2");
    await drainOrchestrationQueue(companyId, run.id, 10);

    expect(executionCounts.get("s2")).toBe(1);
    expect(executionCounts.get("s3")).toBe(1);

    const persisted = await store.getOrchestratorRun(run.id);
    expect(persisted?.status).toBe("completed");
  });

  it("treats repeated critic retry as degraded usable output so dependents still run", async () => {
    vi.mocked(critiqueStepOutput).mockImplementation(async (step) => (
      step.id === "s2"
        ? { verdict: "retry", reason: "needs stronger evidence", improvement: "add concrete evidence" }
        : { verdict: "pass", reason: "ok" }
    ));

    const run = await launchOrchestration({
      companyId,
      objective: "Ship a durable checklist with quality review",
      trigger: "manual",
    });

    await drainOrchestrationQueue(companyId, run.id, 12);

    const steps = await store.listOrchestratorSteps(run.id);
    const s2 = steps.find((step) => step.id === "s2");
    const s3 = steps.find((step) => step.id === "s3");
    expect(s2?.status).toBe("completed");
    expect(s2?.output).toContain("DEGRADED");
    expect(s3?.status).toBe("completed");
    expect(executionCounts.get("s3")).toBe(1);

    const persisted = await store.getOrchestratorRun(run.id);
    expect(persisted?.status).toBe("completed");
    expect(persisted?.summary).toContain("Run consolidated");
  });

  it("does not block completed tool-backed work when the critic schema fails", async () => {
    vi.mocked(executeStepWithRuntime).mockImplementation(async ({ step }) => {
      executionCounts.set(step.id, (executionCounts.get(step.id) ?? 0) + 1);
      return {
        output: step.id === "s2"
          ? "Created a Workbench Sandbox session workbench_1, ran npm test with exit code 0, and captured diff evidence."
          : `output:${step.id}`,
        handoff: {
          contractVersion: "v1",
          stepId: step.id,
          seat: step.agentRole,
          summary: step.id === "s2"
            ? "Workbench Sandbox completed with npm test exit code 0 and diff evidence."
            : `output:${step.id}`,
          keyPoints: [],
          nextActions: [],
          risks: [],
          whatIDidNotDo: [],
          artifactRefs: [],
        },
        model: "test-model",
        tokens: 5,
        costCents: 1,
        toolCalls: step.id === "s2"
          ? [{
              adapter: "Workbench Sandbox",
              action: "{\"kind\":\"workbench:session\",\"writeFiles\":[{\"path\":\"package.json\",\"content\":\"{}\"}],\"command\":\"npm test\"}",
              status: "completed",
              summary: "Workbench Sandbox session workbench_1 wrote package.json. Ran `npm test` with exit code 0. Diff: diff --git a/package.json b/package.json",
            }]
          : [],
        workRequests: [],
        execution: {
          id: makeId("exec"),
          companyId: "company",
          cycleId: "cycle",
          agentRole: step.agentRole,
          input: step.expectedOutput,
          output: step.id === "s2"
            ? "Created a Workbench Sandbox session workbench_1, ran npm test with exit code 0, and captured diff evidence."
            : `output:${step.id}`,
          toolCalls: step.id === "s2"
            ? [{
                adapter: "Workbench Sandbox",
                action: "{\"kind\":\"workbench:session\",\"writeFiles\":[{\"path\":\"package.json\",\"content\":\"{}\"}],\"command\":\"npm test\"}",
                status: "completed",
                summary: "Workbench Sandbox session workbench_1 wrote package.json. Ran `npm test` with exit code 0. Diff: diff --git a/package.json b/package.json",
              }]
            : [],
          status: "completed",
          model: "test-model",
          tokens: 5,
          costCents: 1,
          summary: `output:${step.id}`,
          durationMs: 1,
          createdAt: new Date().toISOString(),
        },
      };
    });
    vi.mocked(critiqueStepOutput).mockImplementation(async (step) => (
      step.id === "s2"
        ? {
            verdict: "escalate",
            reason: "critic LLM call failed: gpt-4.1-mini response failed schema validation: Expected string, received boolean",
            improvement: "Require human review before considering this step complete.",
          }
        : { verdict: "pass", reason: "ok" }
    ));

    const run = await launchOrchestration({
      companyId,
      objective: "Prove engineer Workbench execution with critic schema failure",
      trigger: "manual",
    });

    await drainOrchestrationQueue(companyId, run.id, 12);

    const steps = await store.listOrchestratorSteps(run.id);
    const s2 = steps.find((step) => step.id === "s2");
    const s3 = steps.find((step) => step.id === "s3");
    expect(s2?.status).toBe("completed");
    expect(s2?.output).toContain("DEGRADED");
    expect(s2?.output).toContain("critic infrastructure");
    expect(s3?.status).toBe("completed");
    expect(executionCounts.get("s3")).toBe(1);

    const persisted = await store.getOrchestratorRun(run.id);
    expect(persisted?.status).toBe("completed");
  });

  it("marks stale running runs failed when no worker activity remains", async () => {
    vi.stubEnv("ORC_STALE_RUN_MS", "1");
    const staleAt = "2026-06-10T00:00:00.000Z";
    const run = await store.createOrchestratorRun({
      id: makeId("orc"),
      companyId,
      objective: "Stale worker test",
      trigger: "manual",
      status: "running",
      modelPolicy: {},
      budgetCents: 250,
      costCents: 0,
      summary: undefined,
      cycleId: undefined,
      startedAt: staleAt,
      updatedAt: staleAt,
    });
    await store.upsertOrchestratorStep({
      id: "s1",
      runId: run.id,
      companyId,
      seq: 1,
      title: "Long running step",
      rationale: "exercise stale detection",
      agentRole: "engineer",
      dependsOn: [],
      expectedOutput: "Done",
      riskLevel: "medium",
      needsApproval: false,
      status: "running",
      startedAt: staleAt,
    });

    const addJob = vi.fn().mockResolvedValue(undefined);
    const result = await requeueRunningOrchestrationJobs({ companyId, addJob });

    expect(result.requeued).toBe(0);
    expect(addJob).not.toHaveBeenCalled();
    await expect(store.getOrchestratorRun(run.id)).resolves.toEqual(expect.objectContaining({
      status: "failed",
      summary: expect.stringContaining("stale"),
      completedAt: expect.any(String),
    }));
    await expect(store.listOrchestratorEvents(run.id)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "run_failed",
        payload: expect.objectContaining({ detail: expect.stringContaining("stale") }),
      }),
    ]));
  });
});

function runsCacheClear(runId: string) {
  const globalForOrc = globalThis as unknown as { __trentOrcRuns?: Map<string, unknown> };
  globalForOrc.__trentOrcRuns?.delete(runId);
}
