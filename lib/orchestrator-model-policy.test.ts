import { describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ jsonModel: "" }));

vi.mock("@/lib/ai-client", async () => {
  return {
    MODELS: {
      FAST: "fast-model",
      DEFAULT: "default-model",
      STRONG: "strong-model",
      CODING: "coding-model",
      CRITIC: "critic-model",
    },
    MAX_TOKENS: { JSON: 8192, PROSE: 4096, CHAT: 8192, PLANNING: 8192 },
    callJson: vi.fn(async (model: string, _system: string, _user: string, schema: { parse(input: unknown): unknown }) => {
      captured.jsonModel = model;
      return {
        data: schema.parse({ verdict: "pass", reason: "ok" }),
        tokens: 42,
      };
    }),
    callText: vi.fn(async (model: string) => ({ text: `text from ${model}`, tokens: 10 })),
  };
});

describe("orchestrator model policy", () => {
  it("uses the critic model for step critique instead of the default specialist model", async () => {
    const { critiqueStepOutput } = await import("@/lib/orchestrator-runtime");

    await critiqueStepOutput(
      {
        id: "s1",
        title: "Review risky output",
        rationale: "quality gate",
        agentRole: "escalation",
        dependsOn: [],
        expectedOutput: "strict critique",
        riskLevel: "high",
        needsApproval: false,
      },
      "Looks fine.",
    );

    expect(captured.jsonModel).toBe("critic-model");
  });
});
