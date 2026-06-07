import { afterEach, describe, expect, it, vi } from "vitest";
import { store } from "@/lib/store";
import { makeId } from "@/lib/utils";
import type { OrchestrationPlan } from "@/lib/orchestrator-runtime";

const basePlan = vi.hoisted((): OrchestrationPlan => ({
  objective: "Ship a revised checklist",
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

const executionCounts = vi.hoisted(() => new Map<string, number>());
const s2CritiqueCount = vi.hoisted(() => ({ value: 0 }));

vi.mock("@/lib/spend", () => ({
  assertSpendAvailable: vi.fn().mockResolvedValue(undefined),
  assertAgentTokenBudget: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/agent-runtime", () => ({
  getAgentRuntime: vi.fn().mockResolvedValue({
    role: "ceo",
    slotContract: { mission: "coordinate" },
    environment: { tools: [], approvalRequiredFor: [], budgetCentsPerRun: 50 },
    systemPrompt: "SYS",
  }),
}));

vi.mock("@/lib/ai", () => ({
  ceoChatResponse: vi.fn().mockResolvedValue({ suggestions: [] }),
}));

vi.mock("@/lib/memory-tiers", () => ({
  writeEpisodicMemory: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/orchestrator-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/orchestrator-runtime")>();
  return {
    ...actual,
    generateOrchestrationPlan: vi.fn().mockResolvedValue(basePlan),
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
        },
      };
    }),
    critiqueStepOutput: vi.fn().mockImplementation(async (step) => {
      if (step.id === "s2") {
        s2CritiqueCount.value += 1;
        return s2CritiqueCount.value === 1
          ? { verdict: "replan", reason: "plan assumed wrong toolchain" }
          : { verdict: "pass", reason: "recovery ok" };
      }
      return { verdict: "pass", reason: "ok" };
    }),
    consolidateRun: vi.fn().mockResolvedValue("Run consolidated after replan"),
  };
});

const { processJobData } = await import("@/lib/queue");
const { launchOrchestration, getOrchestrationRun } = await import("@/lib/orchestrator");

async function drainQueue(companyId: string, runId: string, maxJobs = 20) {
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

describe("structural recovery end-to-end", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("revises the tail after a structural failure and completes without re-running completed steps", async () => {
    executionCounts.clear();
    s2CritiqueCount.value = 0;
    vi.stubEnv("OPENAI_API_KEY", "");

    const company = await store.createCompany({
      name: `Structural Recovery ${makeId("test")}`,
      brief: { vision: "replan e2e" },
    });

    const run = await launchOrchestration({
      companyId: company.id,
      objective: basePlan.objective,
      trigger: "manual",
    });

    await drainQueue(company.id, run.id, 15);

    expect(executionCounts.get("s1")).toBe(1);
    expect(executionCounts.get("s2")).toBe(1);

    const live = getOrchestrationRun(run.id);
    const persisted = await store.getOrchestratorRun(run.id);
    const steps = await store.listOrchestratorSteps(run.id);
    const status = live?.status ?? persisted?.status;

    expect(status).toBe("completed");
    expect(steps.find((step) => step.id === "s1")?.status).toBe("completed");
    expect(steps.find((step) => step.id === "s2")?.status).toBe("failed");
    expect(steps.some((step) => /Recovery/i.test(step.title))).toBe(true);
    expect(steps.some((step) => step.status === "completed" && step.id !== "s1" && step.id !== "s2")).toBe(true);
    expect(steps.find((step) => step.title === "Consolidate" && step.dependsOn.includes("s2"))).toBeUndefined();
  });
});
