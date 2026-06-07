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
});
