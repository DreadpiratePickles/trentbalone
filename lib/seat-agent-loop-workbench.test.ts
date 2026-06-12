import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AgentRuntime } from "@/lib/agent-runtime";
import type { Subtask } from "@/lib/planner";
import type { ToolAdapter } from "@/lib/tools";
import { runSeatAgent } from "@/lib/seat-agent-loop";
import { createWorkbenchSandboxToolAdapter } from "@/lib/workbench-sandbox-tool-adapter";
import { fakeWorkbenchProvider, fakeWorkbenchSession } from "@/lib/workbench-test-fakes";

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
    seat: "engineer",
    objective: "Write a test file and run it in Workbench",
    outputContractId: "orchestration:s1",
    toolGuidance: ["workbench:session"],
    boundaries: [],
    input: {},
    contextBundle: { company: { name: "Acme" } },
    classification: { type: "engineer", complexity: "standard", reversibility: "reversible" },
    budgetCents: 100,
    ...overrides,
  };
}

function makeRuntime(tools: string[], extraAdapters: ToolAdapter[] = []): {
  runtime: AgentRuntime;
  adapters: ToolAdapter[];
} {
  return {
    runtime: {
      role: "engineer",
      slotContract: { mission: "build and verify software" } as AgentRuntime["slotContract"],
      environment: {
        tools,
        approvalRequiredFor: [],
        budgetCentsPerRun: 500,
        memoryNamespace: "engineer",
        maxRuntimeSeconds: 900,
        outputContract: ["implementation_plan", "test_plan"],
      },
      staticPrompt: "",
      dynamicPrompt: "",
      systemPrompt: "You are an engineer.",
    },
    adapters: extraAdapters,
  };
}

describe("runSeatAgent workbench execution", () => {
  beforeEach(() => {
    mockExecuteSeatModel.mockReset();
  });

  it("lets the engineer open a workbench session, write code, run tests, and return a real diff", async () => {
    const session = fakeWorkbenchSession();
    const provider = fakeWorkbenchProvider();
    const sandboxAdapter = createWorkbenchSandboxToolAdapter({
      env: { E2B_API_KEY: "e2b_secret" },
      createSessionFn: vi.fn(async () => session),
      getProviderFn: vi.fn(() => provider),
    });
    const action = JSON.stringify({
      kind: "workbench:session",
      objective: "prove engineer can write and test code",
      writeFiles: [
        { path: "src/seat-proof.test.ts", content: "test('seat proof', () => expect(2 + 2).toBe(4));\n" },
      ],
      command: "npm test",
    });
    mockExecuteSeatModel
      .mockResolvedValueOnce({
        output: { toolCall: { name: "workbench:session", action } },
        model: "gpt-4o-mini",
        tokens: 20,
        costCents: 1,
        fallback: false,
      })
      .mockResolvedValueOnce({
        output: {
          toolCall: null,
          summary: "Workbench session wrote src/seat-proof.test.ts, tests passed, and produced a diff",
          findings: [],
          recommendations: [],
          workRequests: [],
        },
        model: "gpt-4o-mini",
        tokens: 20,
        costCents: 1,
        fallback: false,
      });

    const { runtime, adapters } = makeRuntime(["Workbench Sandbox", "workbench:session"], [sandboxAdapter]);
    const result = await runSeatAgent({
      companyId: "co_1",
      runtime,
      subtask: makeSubtask(),
      systemPrompt: runtime.systemPrompt,
      adapters,
    });

    expect(provider.writeFile).toHaveBeenCalledWith(session, "src/seat-proof.test.ts", "test('seat proof', () => expect(2 + 2).toBe(4));\n");
    expect(provider.exec).toHaveBeenCalledWith(session, "npm test", expect.anything());
    expect(result.toolCalls[0]).toMatchObject({
      adapter: "Workbench Sandbox",
      status: "completed",
    });
    expect(result.toolCalls[0]?.summary).toContain("diff --git");
    expect(result.output?.summary).toContain("tests passed");
  });

  it("gives engineer and analyst seats an adaptive 15-step loop when tools keep making progress", async () => {
    const progressAdapter: ToolAdapter = {
      name: "Workbench Sandbox",
      scopes: ["sandbox:exec"],
      async healthCheck() { return "connected"; },
      estimateCost() { return 5; },
      requiresApproval() { return false; },
      async execute(action) {
        return { adapter: "Workbench Sandbox", action, status: "completed", summary: `progress ${action}` };
      },
    };
    for (let i = 1; i <= 7; i += 1) {
      mockExecuteSeatModel.mockResolvedValueOnce({
        output: { toolCall: { name: "sandbox:exec", action: `run tests ${i}` } },
        model: "gpt-4o-mini",
        tokens: 10,
        costCents: 1,
        fallback: false,
      });
    }
    mockExecuteSeatModel.mockResolvedValueOnce({
      output: {
        toolCall: null,
        summary: "Finished after seven progressive tool calls",
        findings: [],
        recommendations: [],
        workRequests: [],
      },
      model: "gpt-4o-mini",
      tokens: 10,
      costCents: 1,
      fallback: false,
    });

    const { runtime, adapters } = makeRuntime(["Workbench Sandbox", "sandbox:exec"], [progressAdapter]);
    const result = await runSeatAgent({
      companyId: "co_1",
      runtime,
      subtask: makeSubtask({
        objective: "Keep running tests while each attempt makes progress",
        toolGuidance: ["sandbox:exec"],
      }),
      systemPrompt: runtime.systemPrompt,
      adapters,
    });

    expect(mockExecuteSeatModel).toHaveBeenCalledTimes(8);
    expect(result.maxStepsReached).toBeFalsy();
    expect(result.toolCalls).toHaveLength(7);
    expect(result.output?.summary).toContain("seven progressive");
  });
});
