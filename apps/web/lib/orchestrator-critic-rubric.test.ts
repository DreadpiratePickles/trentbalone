import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrchestrationStep } from "@/lib/orchestrator-runtime";

const captured = vi.hoisted(() => ({
  system: "",
  user: "",
  reply: {} as Record<string, unknown>,
}));

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
    callJson: vi.fn(async (_model: string, system: string, user: string, schema: { parse(input: unknown): unknown }) => {
      captured.system = system;
      captured.user = user;
      return { data: schema.parse(captured.reply), tokens: 42 };
    }),
    callText: vi.fn(async (model: string) => ({ text: `text from ${model}`, tokens: 10 })),
  };
});

function step(overrides: Partial<OrchestrationStep> = {}): OrchestrationStep {
  return {
    id: "s1",
    title: "Ship weekly metrics digest",
    rationale: "analyst quality gate",
    agentRole: "analyst",
    dependsOn: [],
    expectedOutput: "Digest with cited numbers",
    riskLevel: "medium",
    needsApproval: false,
    spec: {
      acceptance: ["Cites at least three source documents", "Includes week-over-week deltas"],
      inputsFrom: [],
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("critic rubric mode (CRITIC_RUBRIC_ENABLED)", () => {
  it("flag off: legacy prompt, no rubric block, verdict passes through", async () => {
    vi.stubEnv("CRITIC_RUBRIC_ENABLED", "");
    const { critiqueStepOutput } = await import("@/lib/orchestrator-runtime");
    captured.reply = { verdict: "pass", reason: "ok" };

    const critique = await critiqueStepOutput(step(), "All good.");

    expect(critique.verdict).toBe("pass");
    expect(critique.scores).toBeUndefined();
    expect(captured.system).not.toContain("rubric dimension");
    expect(captured.user).not.toContain("Acceptance checklist");
  });

  it("flag on: prompt carries anchors, acceptance bullets, and the seat's success metrics", async () => {
    vi.stubEnv("CRITIC_RUBRIC_ENABLED", "1");
    const { critiqueStepOutput } = await import("@/lib/orchestrator-runtime");
    const { SLOT_CONTRACTS } = await import("@/lib/agent-catalog");
    captured.reply = {
      verdict: "pass",
      reason: "ok",
      scores: { completeness: 3, correctness: 3, safety: 3, followsSpec: 3 },
    };

    const critique = await critiqueStepOutput(step(), "All good.");

    expect(critique.verdict).toBe("pass");
    expect(critique.scores).toEqual({ completeness: 3, correctness: 3, safety: 3, followsSpec: 3 });
    expect(captured.system).toContain("score each rubric dimension independently");
    expect(captured.system).toContain("0: absent or off-topic");
    expect(captured.user).toContain("Cites at least three source documents");
    for (const metric of SLOT_CONTRACTS.analyst.successMetrics) {
      expect(captured.user).toContain(metric);
    }
  });

  it("guard: safety<2 forces escalate over a model 'pass'", async () => {
    vi.stubEnv("CRITIC_RUBRIC_ENABLED", "1");
    const { critiqueStepOutput } = await import("@/lib/orchestrator-runtime");
    captured.reply = {
      verdict: "pass",
      reason: "looks fine",
      scores: { completeness: 3, correctness: 3, safety: 1, followsSpec: 3 },
    };

    const critique = await critiqueStepOutput(step(), "Pushed straight to prod.");

    expect(critique.verdict).toBe("escalate");
    expect(critique.reason).toContain("rubric guard");
  });

  it("guard: followsSpec<2 forces retry over a model 'pass' (spec-violating output cannot pass)", async () => {
    vi.stubEnv("CRITIC_RUBRIC_ENABLED", "1");
    const { critiqueStepOutput } = await import("@/lib/orchestrator-runtime");
    captured.reply = {
      verdict: "pass",
      reason: "nice prose",
      scores: { completeness: 2, correctness: 2, safety: 3, followsSpec: 1 },
    };

    const critique = await critiqueStepOutput(step(), "Digest without any citations.");

    expect(critique.verdict).toBe("retry");
  });

  it("guard: keeps the model's replan when followsSpec<2 and the plan shape is wrong", async () => {
    vi.stubEnv("CRITIC_RUBRIC_ENABLED", "1");
    const { critiqueStepOutput } = await import("@/lib/orchestrator-runtime");
    captured.reply = {
      verdict: "replan",
      reason: "wrong decomposition",
      scores: { completeness: 1, correctness: 2, safety: 3, followsSpec: 0 },
    };

    const critique = await critiqueStepOutput(step(), "Did a different task entirely.");

    expect(critique.verdict).toBe("replan");
  });

  it("guard: a 'pass' with substandard completeness/correctness becomes retry", async () => {
    vi.stubEnv("CRITIC_RUBRIC_ENABLED", "1");
    const { critiqueStepOutput } = await import("@/lib/orchestrator-runtime");
    captured.reply = {
      verdict: "pass",
      reason: "close enough",
      scores: { completeness: 1, correctness: 2, safety: 3, followsSpec: 2 },
    };

    const critique = await critiqueStepOutput(step(), "Half a digest.");

    expect(critique.verdict).toBe("retry");
  });

  it("surfaces upstream NEXT ACTIONS to the critic so an ignored handoff can be flagged", async () => {
    vi.stubEnv("CRITIC_RUBRIC_ENABLED", "1");
    const { critiqueStepOutput } = await import("@/lib/orchestrator-runtime");
    const { buildStepHandoff } = await import("@/lib/orchestrator-runtime");
    captured.reply = { verdict: "pass", reason: "ok", scores: { completeness: 2, correctness: 2, safety: 2, followsSpec: 2 } };

    const upstream = buildStepHandoff(
      { id: "dep1", agentRole: "analyst" },
      { summary: "Research done.", findings: [], recommendations: ["Growth: target enterprise ICP"], riskNotes: [], whatIDidNotDo: [], artifactRefs: [] },
      "raw",
    );

    await critiqueStepOutput(step(), "Some growth output.", undefined, [upstream]);

    expect(captured.user).toContain("Upstream agents asked this step to act on these");
    expect(captured.user).toContain("Growth: target enterprise ICP");
    expect(captured.user).toContain("counts against followsSpec");
  });

  it("omits the upstream-asks block when there are no upstream handoffs", async () => {
    vi.stubEnv("CRITIC_RUBRIC_ENABLED", "");
    const { critiqueStepOutput } = await import("@/lib/orchestrator-runtime");
    captured.reply = { verdict: "pass", reason: "ok" };

    await critiqueStepOutput(step(), "output", undefined, []);

    expect(captured.user).not.toContain("Upstream agents asked");
  });

  it("coerces a boolean reason to a string instead of failing the verdict", async () => {
    vi.stubEnv("CRITIC_RUBRIC_ENABLED", "");
    const { critiqueStepOutput } = await import("@/lib/orchestrator-runtime");
    // The critic model returned `reason: true` (boolean) — a common schema slip.
    captured.reply = { verdict: "pass", reason: true };

    const critique = await critiqueStepOutput(step(), "All good.");

    expect(critique.verdict).toBe("pass");
    expect(critique.reason).toBe("true");
  });

  it("treats an unknown verdict the schema cannot coerce as a clear critic failure (escalate)", async () => {
    vi.stubEnv("CRITIC_RUBRIC_ENABLED", "");
    const { critiqueStepOutput } = await import("@/lib/orchestrator-runtime");
    // `maybe` is not a valid verdict; coercion can't fix it and the repair retry
    // (same mock) fails too — the critic must surface a clear escalate, never a pass.
    captured.reply = { verdict: "maybe", reason: "unsure" };

    const critique = await critiqueStepOutput(step(), "Ambiguous output.");

    expect(critique.verdict).toBe("escalate");
    expect(critique.reason).toContain("critic LLM call failed");
  });

  it("falls back to the expected-output bullet when a step has no spec contract", async () => {
    vi.stubEnv("CRITIC_RUBRIC_ENABLED", "1");
    const { critiqueStepOutput } = await import("@/lib/orchestrator-runtime");
    captured.reply = {
      verdict: "pass",
      reason: "ok",
      scores: { completeness: 2, correctness: 2, safety: 2, followsSpec: 2 },
    };

    await critiqueStepOutput(step({ spec: undefined }), "Output.");

    expect(captured.user).toContain("Expected output satisfied: Digest with cited numbers");
  });
});
