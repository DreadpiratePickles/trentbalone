import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ToolAdapter } from "@/lib/tools";
import type { AgentRuntime } from "@/lib/agent-runtime";
import type { Subtask } from "@/lib/planner";
import { runSeatAgent } from "@/lib/seat-agent-loop";

const mockExecuteSeatModel = vi.fn();

vi.mock("@/lib/model-gateway", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/model-gateway")>();
  return {
    ...actual,
    executeSeatModel: (...args: unknown[]) => mockExecuteSeatModel(...args),
  };
});

function makeSubtask(overrides: Partial<Subtask> = {}): Subtask {
  return {
    id: "sub_1",
    seat: "analyst",
    objective: "Analyze revenue trends",
    outputContractId: "orchestration:s1",
    toolGuidance: ["Metrics"],
    boundaries: [],
    input: {},
    contextBundle: { company: { name: "Acme" } },
    classification: { type: "analyst", complexity: "standard", reversibility: "reversible" },
    budgetCents: 100,
    ...overrides,
  };
}

function makeRuntime(tools: string[], extraAdapters: ToolAdapter[] = []): {
  runtime: AgentRuntime;
  adapters: ToolAdapter[];
} {
  const metricsAdapter: ToolAdapter = {
    name: "Metrics",
    scopes: ["read"],
    async healthCheck() { return "mocked"; },
    estimateCost() { return 0; },
    requiresApproval() { return false; },
    async execute(action) {
      return { adapter: "Metrics", action, status: "completed", summary: "Revenue: $1M MRR" };
    },
  };
  const spendAdapter: ToolAdapter = {
    name: "Stripe",
    scopes: ["charge"],
    async healthCheck() { return "mocked"; },
    estimateCost() { return 50; },
    requiresApproval(action) { return action.toLowerCase().includes("charge"); },
    async execute(action) {
      return { adapter: "Stripe", action, status: "completed", summary: "Charged customer" };
    },
    async dryRun(action) {
      return { adapter: "Stripe", action, status: "needs_approval", summary: "Stripe charge requires approval" };
    },
  };

  const adapters = [metricsAdapter, spendAdapter, ...extraAdapters];
  return {
    runtime: {
      role: "analyst",
      slotContract: { mission: "analyze data" } as AgentRuntime["slotContract"],
      environment: {
        tools,
        approvalRequiredFor: [],
        budgetCentsPerRun: 100,
        memoryNamespace: "analyst",
        maxRuntimeSeconds: 300,
        outputContract: ["analyst.v1"],
      },
      staticPrompt: "",
      dynamicPrompt: "",
      systemPrompt: "You are an analyst.",
    },
    adapters,
  };
}

describe("runSeatAgent", () => {
  beforeEach(() => {
    mockExecuteSeatModel.mockReset();
  });

  it("(a) calls a read tool, feeds the result into the next prompt, and shapes the final output", async () => {
    const capturedPrompts: string[] = [];
    mockExecuteSeatModel
      .mockImplementationOnce(async (input: { toolLoopContext?: { toolHistory: unknown[] }; dynamicPrompt?: string }) => {
        capturedPrompts.push(JSON.stringify(input.toolLoopContext ?? {}));
        return {
          output: { toolCall: { name: "Metrics", action: "fetch revenue metrics" } },
          model: "gpt-4o-mini",
          tokens: 100,
          costCents: 1,
          fallback: false,
        };
      })
      .mockImplementationOnce(async (input: { toolLoopContext?: { toolHistory: unknown[] }; dynamicPrompt?: string }) => {
        capturedPrompts.push(JSON.stringify(input.toolLoopContext ?? {}));
        const history = input.toolLoopContext?.toolHistory ?? [];
        if (!history.some((entry) => {
          const h = entry as { result?: { summary?: string } };
          return h.result?.summary?.includes("$1M");
        })) {
          return {
            output: { toolCall: { name: "Metrics", action: "retry" } },
            model: "gpt-4o-mini",
            tokens: 50,
            costCents: 1,
            fallback: false,
          };
        }
        return {
          output: {
            toolCall: null,
            summary: "Revenue is $1M MRR per the metrics tool",
            findings: ["MRR stable"],
            recommendations: [],
            workRequests: [],
          },
          model: "gpt-4o-mini",
          tokens: 80,
          costCents: 1,
          fallback: false,
        };
      });

    const { runtime, adapters } = makeRuntime(["Metrics"]);
    const result = await runSeatAgent({
      companyId: "co_1",
      runtime,
      subtask: makeSubtask(),
      systemPrompt: runtime.systemPrompt,
      adapters,
    });

    expect(mockExecuteSeatModel).toHaveBeenCalledTimes(2);
    expect(capturedPrompts[1]).toContain("Revenue: $1M MRR");
    expect(result.toolCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ adapter: "Metrics", status: "completed", summary: "Revenue: $1M MRR" }),
    ]));
    expect(result.output).toMatchObject({
      summary: expect.stringContaining("$1M"),
    });
    expect(result.pausedForApproval).toBeFalsy();
  });

  it("(b) resumes mid-loop after approval without re-executing completed tools", async () => {
    mockExecuteSeatModel.mockResolvedValueOnce({
      output: {
        toolCall: null,
        summary: "Charged customer after metrics review",
        findings: [],
        recommendations: [],
        workRequests: [],
      },
      model: "gpt-4o-mini",
      tokens: 80,
      costCents: 1,
      fallback: false,
    });

    const { runtime, adapters } = makeRuntime(["Metrics", "Stripe"]);
    const resumed = await runSeatAgent({
      companyId: "co_1",
      runtime,
      subtask: makeSubtask({ seat: "finance", toolGuidance: ["Stripe"] }),
      systemPrompt: runtime.systemPrompt,
      approvalGranted: true,
      adapters,
      resumeSeed: {
        toolCalls: [
          { adapter: "Metrics", action: "fetch revenue", status: "completed", summary: "Revenue: $1M MRR" },
          { adapter: "Stripe", action: "charge the customer $50", status: "needs_approval", summary: "Stripe charge requires approval" },
        ],
        loopStep: 2,
        tokens: 160,
        costCents: 2,
        model: "gpt-4o-mini",
        pendingToolCall: { name: "Stripe", action: "charge the customer $50" },
      },
    });

    expect(mockExecuteSeatModel).toHaveBeenCalledTimes(1);
    expect(resumed.toolCalls).toEqual([
      expect.objectContaining({ adapter: "Metrics", status: "completed" }),
      expect.objectContaining({ adapter: "Stripe", status: "completed", summary: "Charged customer" }),
    ]);
    expect(resumed.pausedForApproval).toBeFalsy();
    expect(resumed.output).toMatchObject({ summary: expect.stringContaining("Charged customer") });
  });

  it("(c) pauses mid-loop when a tool needs approval and approval was not granted", async () => {
    mockExecuteSeatModel.mockResolvedValueOnce({
      output: { toolCall: { name: "Stripe", action: "charge the customer $50" } },
      model: "gpt-4o-mini",
      tokens: 100,
      costCents: 1,
      fallback: false,
    });

    const { runtime, adapters } = makeRuntime(["Stripe"]);
    const result = await runSeatAgent({
      companyId: "co_1",
      runtime,
      subtask: makeSubtask({ seat: "finance", toolGuidance: ["Stripe"] }),
      systemPrompt: runtime.systemPrompt,
      approvalGranted: false,
      adapters,
    });

    expect(mockExecuteSeatModel).toHaveBeenCalledTimes(1);
    expect(result.pausedForApproval).toBe(true);
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        adapter: "Stripe",
        status: "needs_approval",
        summary: expect.stringContaining("approval"),
      }),
    ]);
    expect(result.output).toBeNull();
  });

  it("(d) stops at maxSteps without infinite looping when the model keeps requesting tools", async () => {
    mockExecuteSeatModel.mockImplementation(async () => ({
      output: { toolCall: { name: "Metrics", action: "keep reading" } },
      model: "gpt-4o-mini",
      tokens: 10,
      costCents: 1,
      fallback: false,
    }));

    const { runtime, adapters } = makeRuntime(["Metrics"]);
    const result = await runSeatAgent({
      companyId: "co_1",
      runtime,
      subtask: makeSubtask(),
      systemPrompt: runtime.systemPrompt,
      maxSteps: 3,
      adapters,
    });

    expect(mockExecuteSeatModel).toHaveBeenCalledTimes(3);
    expect(result.toolCalls).toHaveLength(3);
    expect(result.maxStepsReached).toBe(true);
    expect(result.output).toMatchObject({
      summary: expect.stringContaining("max tool-use steps"),
    });
  });

  it("executes a scoped sandbox tool call when guidance names sandbox:exec instead of adapter display name", async () => {
    const sandboxAdapter: ToolAdapter = {
      name: "Workbench Sandbox",
      scopes: ["sandbox:exec", "tests:run"],
      async healthCheck() { return "connected"; },
      estimateCost() { return 5; },
      requiresApproval() { return false; },
      async execute(action) {
        return { adapter: "Workbench Sandbox", action, status: "completed", summary: "Sandbox tests passed" };
      },
    };
    mockExecuteSeatModel
      .mockResolvedValueOnce({
        output: { toolCall: { name: "sandbox:exec", action: "run tests" } },
        model: "gpt-4o-mini",
        tokens: 20,
        costCents: 1,
        fallback: false,
      })
      .mockResolvedValueOnce({
        output: {
          toolCall: null,
          summary: "Tests passed in the Workbench sandbox",
          findings: [],
          recommendations: [],
          workRequests: [],
        },
        model: "gpt-4o-mini",
        tokens: 20,
        costCents: 1,
        fallback: false,
      });

    const { runtime, adapters } = makeRuntime(["Workbench Sandbox", "sandbox:exec"], [sandboxAdapter]);
    const result = await runSeatAgent({
      companyId: "co_1",
      runtime,
      subtask: makeSubtask({
        seat: "engineer",
        objective: "Run tests in a real sandbox",
        toolGuidance: ["sandbox:exec"],
      }),
      systemPrompt: runtime.systemPrompt,
      adapters,
    });

    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        adapter: "Workbench Sandbox",
        action: "run tests",
        status: "completed",
      }),
    ]);
    expect(result.output?.summary).toContain("Tests passed");
  });

  it("advertises and executes internal action tools through the contract table", async () => {
    const capturedAvailableTools: string[][] = [];
    mockExecuteSeatModel
      .mockImplementationOnce(async (input: { toolLoopContext?: { availableTools?: string[] } }) => {
        capturedAvailableTools.push(input.toolLoopContext?.availableTools ?? []);
        return {
          output: { toolCall: { name: "tasks:create", action: "Create a follow-up task" } },
          model: "gpt-4o-mini",
          tokens: 20,
          costCents: 1,
          fallback: false,
        };
      })
      .mockResolvedValueOnce({
        output: {
          toolCall: null,
          summary: "Task was created internally",
          findings: [],
          recommendations: [],
          workRequests: [],
        },
        model: "gpt-4o-mini",
        tokens: 20,
        costCents: 1,
        fallback: false,
      });

    const { runtime, adapters } = makeRuntime(["tasks:create"]);
    const result = await runSeatAgent({
      companyId: "co_1",
      runtime,
      subtask: makeSubtask({
        seat: "ceo",
        objective: "Create a follow-up task",
        toolGuidance: ["tasks:create"],
      }),
      systemPrompt: runtime.systemPrompt,
      adapters,
    });

    expect(capturedAvailableTools[0]).toContain("tasks:create");
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        adapter: "tasks:create",
        action: "Create a follow-up task",
        status: "completed",
        summary: expect.stringContaining("Created task"),
      }),
    ]);
  });

  it("throws in test/dev when a contracted tool string has no binding instead of falling back semantically", async () => {
    mockExecuteSeatModel.mockResolvedValueOnce({
      output: { toolCall: { name: "orphan:do_work", action: "Use the orphaned tool" } },
      model: "gpt-4o-mini",
      tokens: 20,
      costCents: 1,
      fallback: false,
    });

    const { runtime, adapters } = makeRuntime(["orphan:do_work", "Metrics"]);
    await expect(runSeatAgent({
      companyId: "co_1",
      runtime,
      subtask: makeSubtask({
        seat: "analyst",
        objective: "Use the orphaned tool",
        toolGuidance: ["orphan:do_work"],
      }),
      systemPrompt: runtime.systemPrompt,
      adapters,
    })).rejects.toThrow(/Contracted tool "orphan:do_work"/);
  });

  it("returns a degraded source-grounded output when a model repeats a disallowed tool", async () => {
    mockExecuteSeatModel.mockImplementation(async () => ({
      output: { toolCall: { name: "analytics:read_mock", action: "read analytics" } },
      model: "gpt-4o-mini",
      tokens: 10,
      costCents: 1,
      fallback: false,
    }));

    const { runtime, adapters } = makeRuntime(["Metrics"]);
    const result = await runSeatAgent({
      companyId: "co_1",
      runtime,
      subtask: makeSubtask({
        contextBundle: {
          company: { name: "Acme" },
          sourceCoverage: "SOURCE COVERAGE:\n- Available: analytics (doc doc_analytics)",
          sourceDocuments: "SOURCE DOCUMENTS (cite by id when you use one):\n[doc_analytics] analytics.json\n{\"activation\":0.42}",
        },
      }),
      systemPrompt: runtime.systemPrompt,
      maxSteps: 6,
      adapters,
    });

    expect(mockExecuteSeatModel).toHaveBeenCalledTimes(2);
    expect(result.maxStepsReached).toBeFalsy();
    expect(result.output).toMatchObject({
      summary: expect.stringContaining("DEGRADED"),
    });
    expect(result.output?.summary).toContain("analytics.json");
    expect(result.toolCalls).toHaveLength(2);
  });

  it("returns a degraded source-grounded output when an allowed tool repeatedly fails validation", async () => {
    const browserAdapter: ToolAdapter = {
      name: "Steel Browser",
      scopes: ["read"],
      async healthCheck() { return "mocked"; },
      estimateCost() { return 0; },
      requiresApproval() { return false; },
      async execute(action) {
        return { adapter: "Steel Browser", action, status: "failed", summary: "Steel Browser action \"scrape\" requires payload.url." };
      },
    };
    mockExecuteSeatModel.mockImplementation(async () => ({
      output: { toolCall: { name: "Steel Browser", action: "scrape" } },
      model: "gpt-4o-mini",
      tokens: 10,
      costCents: 1,
      fallback: false,
    }));

    const { runtime, adapters } = makeRuntime(["Steel Browser"], [browserAdapter]);
    const result = await runSeatAgent({
      companyId: "co_1",
      runtime,
      subtask: makeSubtask({
        toolGuidance: ["Steel Browser"],
        contextBundle: {
          company: { name: "Acme" },
          sourceCoverage: "SOURCE COVERAGE:\n- Available: competitive research (doc doc_competitive)",
          sourceDocuments: "SOURCE DOCUMENTS (cite by id when you use one):\n[doc_competitive] competitive-research.md\nCompetitor notes.",
        },
      }),
      systemPrompt: runtime.systemPrompt,
      maxSteps: 6,
      adapters,
    });

    expect(mockExecuteSeatModel).toHaveBeenCalledTimes(2);
    expect(result.maxStepsReached).toBeFalsy();
    expect(result.output?.summary).toContain("DEGRADED");
    expect(result.output?.summary).toContain("competitive-research.md");
    expect(result.toolCalls).toHaveLength(2);
  });
});
