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
const { generateOrchestrationPlan } = await import("@/lib/orchestrator-runtime");

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

    runsCacheClear(run.id);
    await approveStep(run.id, "s2");
    await drainOrchestrationQueue(companyId, run.id, 10);

    expect(executionCounts.get("s2")).toBe(1);
    expect(executionCounts.get("s3")).toBe(1);

    const persisted = await store.getOrchestratorRun(run.id);
    expect(persisted?.status).toBe("completed");
  });
});

function runsCacheClear(runId: string) {
  const globalForOrc = globalThis as unknown as { __trentOrcRuns?: Map<string, unknown> };
  globalForOrc.__trentOrcRuns?.delete(runId);
}
