import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ceoChatResponse } from "@/lib/ai";
import type { Company } from "@/lib/types";

const mockRuntime = vi.hoisted(() => ({
  getAgentRuntime: vi.fn().mockResolvedValue({ systemPrompt: "CEO system prompt" }),
}));

const mockClient = vi.hoisted(() => ({
  chat: {
    completions: {
      create: vi.fn(),
    },
  },
}));

vi.mock("@/lib/agent-runtime", () => mockRuntime);

vi.mock("@/lib/ai-client", () => ({
  createAIClient: () => mockClient,
  MAX_TOKENS: { CHAT: 1000, PLANNING: 1000, PROSE: 1000 },
  MODELS: { DEFAULT: "test-default", STRONG: "test-strong" },
  modelChatTuning: (_model: string, maxTokens: number, temperature?: number) =>
    typeof temperature === "number" ? { max_tokens: maxTokens, temperature } : { max_tokens: maxTokens },
}));

describe("ceoChatResponse schema tolerance", () => {
  const company: Company = {
    id: "co_1",
    name: "Schema Co",
    createdAt: "2026-06-11T00:00:00.000Z",
    updatedAt: "2026-06-11T00:00:00.000Z",
    brief: { vision: "Ship reliable agent operations.", goals: "Launch grounded campaigns." },
    autonomyLevel: "autonomous_with_approvals",
    publicVisibility: true,
    cycleFrequency: "manual",
    budgetCents: 10_000,
    status: "active",
  } as Company;

  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    mockClient.chat.completions.create.mockReset();
    mockRuntime.getAgentRuntime.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("normalizes model-friendly role labels, nullable optional strings, string tags, and action categories", async () => {
    mockClient.chat.completions.create.mockResolvedValue({
      choices: [{
        message: {
          content: JSON.stringify({
            message: "I will route the launch campaign through growth and keep approvals gated.",
            understood: {
              intent: null,
              routedTo: "Growth / Marketing",
              willDo: null,
              approvalRequired: "false",
            },
            createTasks: [{
              title: "Draft launch campaign",
              prompt: "Use the marketing plan and brand voice.",
              agentRole: "Growth / Marketing",
              priority: "High",
              tags: "campaign, launch",
            }],
            createArtifacts: [{
              title: "Operating memo",
              prompt: "Summarize campaign approval gates.",
              type: "operating_memo",
              createdByAgent: "CEO Orchestrator",
              exportFormat: "markdown",
            }],
            suggestions: [{
              title: "Approve public launch gates",
              body: "Review the draft before anything goes live.",
              category: "action",
            }],
          }),
        },
      }],
      usage: { total_tokens: 120 },
    });

    const response = await ceoChatResponse(company, [], "Draft a launch campaign", { tasks: [] });

    expect(response.message).toContain("route the launch campaign");
    expect(response.understood).toMatchObject({
      routedTo: "Growth / Marketing",
      approvalRequired: false,
    });
    expect(response.createTasks).toEqual([
      expect.objectContaining({
        agentRole: "growth",
        priority: "high",
        tags: ["campaign", "launch"],
      }),
    ]);
    expect(response.createArtifacts).toEqual([
      expect.objectContaining({
        createdByAgent: "ceo",
      }),
    ]);
    expect(response.suggestions).toEqual([
      expect.objectContaining({
        category: "operations",
      }),
    ]);
  });
});
