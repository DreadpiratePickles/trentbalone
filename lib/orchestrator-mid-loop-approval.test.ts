import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "@/lib/store";
import { makeId } from "@/lib/utils";
import type { OrchestrationPlan } from "@/lib/orchestrator-runtime";

const metricsExecuteCount = vi.hoisted(() => ({ count: 0 }));
const stripeExecuteCount = vi.hoisted(() => ({ count: 0 }));

const mockExecuteSeatModel = vi.hoisted(() => vi.fn());

const testAdapters = vi.hoisted(() => [
  {
    name: "Metrics",
    scopes: ["read"],
    async healthCheck(): Promise<"mocked"> { return "mocked"; },
    estimateCost(): number { return 0; },
    requiresApproval(): boolean { return false; },
    async execute(action: string) {
      metricsExecuteCount.count += 1;
      return { adapter: "Metrics", action, status: "completed" as const, summary: "Revenue: $1M MRR" };
    },
  },
  {
    name: "Stripe",
    scopes: ["charge"],
    async healthCheck(): Promise<"mocked"> { return "mocked"; },
    estimateCost(): number { return 50; },
    requiresApproval(action: string): boolean { return action.toLowerCase().includes("charge"); },
    async execute(action: string) {
      stripeExecuteCount.count += 1;
      return { adapter: "Stripe", action, status: "completed" as const, summary: "Charged customer" };
    },
    async dryRun(action: string) {
      return { adapter: "Stripe", action, status: "needs_approval" as const, summary: "Stripe charge requires approval" };
    },
  },
]);

const singleStepPlan = vi.hoisted((): OrchestrationPlan => ({
  objective: "Charge customer after reading metrics",
  reasoning: "test plan",
  steps: [
    {
      id: "s1",
      title: "Finance charge workflow",
      rationale: "Read metrics then charge",
      agentRole: "finance",
      dependsOn: [],
      expectedOutput: "Charge completed",
      riskLevel: "medium",
      needsApproval: false,
    },
  ],
  successCriteria: ["Charge completed"],
  blockers: [],
}));

const mockSpend = vi.hoisted(() => ({
  assertSpendAvailable: vi.fn().mockResolvedValue(undefined),
  assertAgentTokenBudget: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/spend", () => mockSpend);

vi.mock("@/lib/tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tools")>();
  return { ...actual, adapters: testAdapters };
});

vi.mock("@/lib/agent-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent-runtime")>();
  return {
    ...actual,
    getAgentRuntime: vi.fn().mockResolvedValue({
      role: "finance",
      slotContract: { mission: "manage finances" },
      profile: undefined,
      v3Profile: undefined,
      environment: {
        tools: ["Metrics", "Stripe"] as string[],
        approvalRequiredFor: [],
        budgetCentsPerRun: 500,
        memoryNamespace: "finance",
        maxRuntimeSeconds: 300,
        outputContract: ["finance.v1"],
      },
      systemPrompt: "You are finance.",
    }),
  };
});

vi.mock("@/lib/model-gateway", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/model-gateway")>();
  return {
    ...actual,
    executeSeatModel: (...args: unknown[]) => mockExecuteSeatModel(...args),
  };
});

vi.mock("@/lib/ai", () => ({
  executeAgentRole: vi.fn(),
  ceoChatResponse: vi.fn().mockResolvedValue({ suggestions: [] }),
}));

vi.mock("@/lib/memory-tiers", () => ({
  writeEpisodicMemory: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/orchestrator-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/orchestrator-runtime")>();
  return {
    ...actual,
    generateOrchestrationPlan: vi.fn().mockResolvedValue(singleStepPlan),
    critiqueStepOutput: vi.fn().mockResolvedValue({ verdict: "pass", reason: "ok" }),
    consolidateRun: vi.fn().mockResolvedValue("Run consolidated"),
  };
});

const { processJobData } = await import("@/lib/queue");
const { launchOrchestration, approveStep, rejectStep } = await import("@/lib/orchestrator");
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

function runsCacheClear(runId: string) {
  const globalForOrc = globalThis as unknown as { __trentOrcRuns?: Map<string, unknown> };
  globalForOrc.__trentOrcRuns?.delete(runId);
}

describe("mid-loop seat tool approval", () => {
  let companyId: string;

  beforeEach(async () => {
    metricsExecuteCount.count = 0;
    stripeExecuteCount.count = 0;
    mockExecuteSeatModel.mockReset();
    vi.mocked(generateOrchestrationPlan).mockResolvedValue(singleStepPlan);
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("OPENAI_BASE_URL", "");

    mockExecuteSeatModel
      .mockImplementationOnce(async () => ({
        output: { toolCall: { name: "Metrics", action: "fetch revenue metrics" } },
        model: "gpt-4o-mini",
        tokens: 50,
        costCents: 1,
        fallback: false,
      }))
      .mockImplementationOnce(async () => ({
        output: { toolCall: { name: "Stripe", action: "charge the customer $50" } },
        model: "gpt-4o-mini",
        tokens: 60,
        costCents: 1,
        fallback: false,
      }))
      .mockImplementationOnce(async (input: { toolLoopContext?: { toolHistory: unknown[] } }) => {
        const history = input.toolLoopContext?.toolHistory ?? [];
        const charged = history.some((entry) => {
          const h = entry as { result?: { summary?: string; status?: string } };
          return h.result?.status === "completed" && h.result?.summary?.includes("Charged");
        });
        if (!charged) {
          return {
            output: { toolCall: { name: "Stripe", action: "charge the customer $50" } },
            model: "gpt-4o-mini",
            tokens: 40,
            costCents: 1,
            fallback: false,
          };
        }
        return {
          output: {
            toolCall: null,
            summary: "Charged customer after reading metrics",
            findings: [],
            recommendations: [],
            workRequests: [],
          },
          model: "gpt-4o-mini",
          tokens: 70,
          costCents: 1,
          fallback: false,
        };
      });

    const company = await store.createCompany({
      name: `Mid-loop Approval ${makeId("test")}`,
      brief: { vision: "durable mid-loop approval" },
    });
    companyId = company.id;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("suspends the step when a seat hits an approval-requiring tool mid-loop", async () => {
    const run = await launchOrchestration({
      companyId,
      objective: "Charge customer after reading metrics",
      trigger: "manual",
    });

    await drainOrchestrationQueue(companyId, run.id, 5);

    const step = (await store.listOrchestratorSteps(run.id)).find((item) => item.id === "s1");
    expect(step?.status).toBe("awaiting_approval");
    expect(step?.approvalId).toBeTruthy();

    const approval = step?.approvalId ? await store.getApproval(step.approvalId) : undefined;
    expect(approval?.status).toBe("pending");

    const runningJobs = (await store.listJobRuns(companyId))
      .filter((job) => job.type === "orchestration_step" && job.status === "running" && job.metadata?.runId === run.id);
    expect(runningJobs).toHaveLength(0);

    expect(metricsExecuteCount.count).toBe(1);
    expect(stripeExecuteCount.count).toBe(0);

    const toolCalls = step?.toolCalls ?? [];
    expect(toolCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ adapter: "Metrics", status: "completed" }),
      expect.objectContaining({ adapter: "Stripe", status: "needs_approval" }),
    ]));
  });

  it("resumes after approval, executes the approved tool once, and completes the step", async () => {
    const run = await launchOrchestration({
      companyId,
      objective: "Charge customer after reading metrics",
      trigger: "manual",
    });

    await drainOrchestrationQueue(companyId, run.id, 5);
    runsCacheClear(run.id);

    await approveStep(run.id, "s1");
    await drainOrchestrationQueue(companyId, run.id, 10);

    const step = (await store.listOrchestratorSteps(run.id)).find((item) => item.id === "s1");
    expect(step?.status).toBe("completed");
    expect(step?.output).toContain("Charged customer");

    expect(metricsExecuteCount.count).toBe(1);
    expect(stripeExecuteCount.count).toBe(1);

    const toolCalls = step?.toolCalls ?? [];
    expect(toolCalls.filter((call) => call.adapter === "Metrics")).toHaveLength(1);
    expect(toolCalls.filter((call) => call.adapter === "Stripe" && call.status === "completed")).toHaveLength(1);
    expect(toolCalls.filter((call) => call.adapter === "Stripe" && call.status === "needs_approval")).toHaveLength(0);

    const persistedRun = await store.getOrchestratorRun(run.id);
    expect(persistedRun?.status).toBe("completed");
  });

  it("fails cleanly when the mid-loop approval is rejected", async () => {
    const run = await launchOrchestration({
      companyId,
      objective: "Charge customer after reading metrics",
      trigger: "manual",
    });

    await drainOrchestrationQueue(companyId, run.id, 5);
    runsCacheClear(run.id);

    await rejectStep(run.id, "s1");
    await drainOrchestrationQueue(companyId, run.id, 10);

    const step = (await store.listOrchestratorSteps(run.id)).find((item) => item.id === "s1");
    expect(step?.status).toBe("failed");
    expect(step?.output).toContain("rejected");

    expect(stripeExecuteCount.count).toBe(0);
  });

  it("fails and terminates when a seat exhausts tool steps without an allowed tool", async () => {
    mockExecuteSeatModel.mockReset();
    mockExecuteSeatModel.mockImplementation(async () => ({
      output: { toolCall: { name: "analytics:read_mock", action: "read mock analytics" } },
      model: "gpt-4o-mini",
      tokens: 20,
      costCents: 1,
      fallback: false,
    }));

    const run = await launchOrchestration({
      companyId,
      objective: "Read mock analytics that are not available to this seat",
      trigger: "manual",
    });

    await drainOrchestrationQueue(companyId, run.id, 12);

    const step = (await store.listOrchestratorSteps(run.id)).find((item) => item.id === "s1");
    expect(step?.status).toBe("failed");
    expect(step?.approvalId).toBeFalsy();
    expect(step?.output).toContain("Stopped after max tool-use steps");
    expect(step?.output).toContain("Tool \"analytics:read_mock\" is not allowed for this seat.");

    const approvals = await store.listApprovals(companyId);
    expect(approvals.filter((approval) => approval.toolName?.includes(`orchestration:${run.id}:s1:tool`))).toHaveLength(0);

    const persistedRun = await store.getOrchestratorRun(run.id);
    expect(persistedRun?.status).toBe("failed");
  });
});
