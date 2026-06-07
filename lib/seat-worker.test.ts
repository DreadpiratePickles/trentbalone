import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetWorkbenchSession, mockCreateArtifact, mockGetWorkbenchProvider, mockSelfHeal, mockExecuteSeatModel, mockCallJson } = vi.hoisted(() => ({
  mockGetWorkbenchSession: vi.fn(),
  mockCreateArtifact: vi.fn(),
  mockGetWorkbenchProvider: vi.fn(),
  mockSelfHeal: vi.fn(),
  mockExecuteSeatModel: vi.fn(),
  mockCallJson: vi.fn(),
}));

vi.mock("@/lib/agent-runtime", () => ({
  getAgentRuntime: vi.fn(async (_companyId: string, role: string) => ({
    role,
    systemPrompt: `prompt for ${role}`,
    environment: { memoryNamespace: `ns:${role}`, tools: [], approvalRequiredFor: [], budgetCentsPerRun: 100, maxRuntimeSeconds: 60, outputContract: [] },
    slotContract: { role, mission: "mission", inputs: [], deliverables: [], successMetrics: [] },
  })),
}));

vi.mock("@/lib/planner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/planner")>();
  return { ...actual, recordHandoff: vi.fn() };
});

vi.mock("@/lib/store", () => ({
  store: {
    getWorkbenchSession: mockGetWorkbenchSession,
    createArtifact: mockCreateArtifact,
  },
}));

vi.mock("@/lib/workbench-provider", () => ({
  getWorkbenchProvider: mockGetWorkbenchProvider,
}));

vi.mock("@/lib/workbench-self-heal", () => ({
  runWorkbenchSelfHealingLoop: mockSelfHeal,
}));
vi.mock("@/lib/model-gateway", () => ({
  executeSeatModel: mockExecuteSeatModel,
}));
vi.mock("@/lib/ai-client", () => ({
  callJson: mockCallJson,
  MODELS: { FAST: "gpt-4.1-nano" },
  MAX_TOKENS: { JSON: 8192 },
}));

import {
  buildCriticSkillPrompt,
  buildHandoff,
  getCriticSkillNamesForSeat,
  processSubtaskJob,
  SeatWorker,
} from "@/lib/seat-worker";

describe("seat worker", () => {
  beforeEach(() => {
    mockGetWorkbenchSession.mockReset();
    mockCreateArtifact.mockReset();
    mockGetWorkbenchProvider.mockReset();
    mockSelfHeal.mockReset();
    mockExecuteSeatModel.mockReset();
    mockCallJson.mockReset();
    mockCreateArtifact.mockResolvedValue({ id: "artifact_model" });
    mockExecuteSeatModel.mockResolvedValue({
      output: { summary: "Model completed the work" },
      model: "gpt-4.1-mini",
      tokens: 100,
      costCents: 1,
      fallback: false,
    });
    mockCallJson.mockResolvedValue({ data: { pass: true, score: 0.85, issues: [] } });
  });

  it("runs a subtask in an isolated seat runtime and returns an artifact reference", async () => {
    const worker = new SeatWorker("co_1");
    const result = await worker.run({
      id: "sub_1",
      seat: "analyst",
      objective: "Summarize churn risk",
      outputContractId: "analyst.v1",
      toolGuidance: [],
      boundaries: ["read-only"],
      input: {},
      contextBundle: {},
      classification: { type: "analysis", complexity: "standard", reversibility: "reversible" },
      budgetCents: 25,
    });

    expect(mockExecuteSeatModel).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "co_1",
      systemPrompt: "prompt for analyst",
      subtask: expect.objectContaining({ seat: "analyst" }),
    }));
    expect(mockCreateArtifact).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "co_1",
      createdByAgent: "analyst",
      provenance: expect.objectContaining({ model: "gpt-4.1-mini", tokens: 100, costCents: 1 }),
    }));
    expect(result).toMatchObject({ seat: "analyst", confidence: 0.85, costCents: 1, payloadRef: "artifact_model" });
  });

  it("returns low confidence when model execution reports missing configuration", async () => {
    mockExecuteSeatModel.mockResolvedValueOnce({
      output: { error: "OPENAI_API_KEY is not configured" },
      model: "not-configured",
      tokens: 0,
      costCents: 0,
      fallback: true,
      error: "OPENAI_API_KEY is not configured",
    });
    const worker = new SeatWorker("co_1");

    const result = await worker.run({
      id: "sub_missing_key",
      seat: "analyst",
      objective: "Summarize churn risk",
      outputContractId: "analyst.v1",
      toolGuidance: [],
      boundaries: ["read-only"],
      input: {},
      contextBundle: {},
      classification: { type: "analysis", complexity: "standard", reversibility: "reversible" },
      budgetCents: 25,
    });

    expect(result).toMatchObject({
      seat: "analyst",
      confidence: 0,
      error: "OPENAI_API_KEY is not configured",
      payloadRef: "artifact_model",
    });
  });

  it("builds typed handoff events and processes queue jobs", async () => {
    expect(buildHandoff({
      cycleId: "cycle_1",
      from: "engineer",
      to: "analyst",
      reason: "need metrics",
      payloadRef: "artifact_1",
      contractVersion: "v1",
    })).toMatchObject({ from: "engineer", to: "analyst", payloadRef: "artifact_1" });

    await expect(processSubtaskJob({
      companyId: "co_1",
      subtask: {
        id: "sub_2",
        seat: "support",
        objective: "Classify ticket",
        outputContractId: "support.v1",
        toolGuidance: [],
        boundaries: [],
        input: {},
        contextBundle: {},
        classification: { type: "support", complexity: "trivial", reversibility: "reversible" },
        budgetCents: 10,
      },
    })).resolves.toMatchObject({ seat: "support" });
  });

  it("routes engineer self-healing subtasks through the workbench repair loop", async () => {
    const session = { id: "ws_1", provider: "mock_local" };
    const provider = { name: "mock_local" };
    mockGetWorkbenchSession.mockResolvedValue(session);
    mockGetWorkbenchProvider.mockReturnValue(provider);
    mockSelfHeal.mockResolvedValue({ status: "healed", patch: { filePath: "src/math.ts" } });

    const worker = new SeatWorker("co_1");
    const result = await worker.run({
      id: "sub_3",
      seat: "engineer",
      objective: "Self-heal failing workbench tests",
      outputContractId: "engineer.v1",
      toolGuidance: [],
      boundaries: [],
      input: { workbenchSelfHeal: { sessionId: "ws_1", command: "npm test" } },
      contextBundle: {},
      classification: { type: "code", complexity: "standard", reversibility: "reversible" },
      budgetCents: 10,
    });

    expect(mockSelfHeal).toHaveBeenCalledWith({ session, provider, command: "npm test" });
    expect(mockExecuteSeatModel).not.toHaveBeenCalled();
    expect(result).toMatchObject({ seat: "engineer", confidence: 0.85 });
  });

  it("grants Claude Ads only to the growth critic pass", async () => {
    expect(getCriticSkillNamesForSeat("growth")).toEqual(["claude-ads-critic"]);
    expect(getCriticSkillNamesForSeat("engineer")).toEqual([]);

    const prompt = await buildCriticSkillPrompt("growth");
    expect(prompt).toContain("Skill: claude-ads-critic");
    expect(prompt).toContain("paid advertising audit");
  });
});
