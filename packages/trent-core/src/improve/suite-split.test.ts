/**
 * Task I.16 — public/private suite split (CS329A L4 @31:33, RLEF: public tests for iteration,
 * private tests for the reward, so the model cannot memorise the test; L7 @36:21: the scorer must
 * not train on what it ranks). Reflection reads public failures only; the gate scores everything;
 * a candidate that lifts public and drops private is blocked.
 */
import { describe, expect, it } from "vitest";

import type { TraceRecord } from "../traces/trace-store.js";
import { executeGate } from "./gate.js";
import type { FrozenSuite } from "./suites.js";
import { runGepaPass } from "./gepa-pass.js";
import { applyMechanicalOverlay } from "./mechanical-overlay.js";
import { InMemoryImproveStore } from "./memory-store.js";
import { isPrivateFixture, splitSuite } from "./suite-split.js";

const rubric = { type: "llm_rubric" as const, weight: 1, rubric: "Is right." };
const SUITE: FrozenSuite = {
  id: "s",
  version: "v1",
  fixtures: [
    { id: "s:pub1", prompt: "PUBLIC-ONE-TEXT", graders: [rubric], private: false },
    { id: "s:pub2", prompt: "PUBLIC-TWO-TEXT", graders: [rubric], private: false },
    { id: "s:priv1", prompt: "PRIVATE-ONE-TEXT", graders: [rubric], private: true },
  ],
};

describe("splitSuite", () => {
  it("is deterministic per fixture id, holds out roughly 30 percent, and an explicit marker wins", () => {
    const big: FrozenSuite = { id: "big", version: "v", fixtures: Array.from({ length: 40 }, (_, i) => ({ id: `big:${i}`, prompt: `p${i}`, graders: [rubric] })) };
    const a = splitSuite(big);
    const b = splitSuite(big);
    expect(a).toEqual(b);
    expect(a.private.length).toBeGreaterThanOrEqual(6);
    expect(a.private.length).toBeLessThanOrEqual(18);
    expect(a.public.length + a.private.length).toBe(40);
    expect(isPrivateFixture({ id: "x", prompt: "", graders: [], private: true })).toBe(true);
    expect(isPrivateFixture({ id: "x", prompt: "", graders: [], private: false })).toBe(false);
  });

  it("the mechanical overlay can name the private ids", () => {
    const base: FrozenSuite = { id: "ads", version: "v1", fixtures: [{ id: "ads:1", prompt: "a", graders: [rubric], private: false }, { id: "ads:2", prompt: "b", graders: [rubric], private: false }] };
    const out = applyMechanicalOverlay(base, { skill_name: "ads", evals: [], private: [2] });
    expect(out.fixtures.map((f) => f.private)).toEqual([false, true]);
    expect(out.version).not.toBe(base.version);
  });
});

describe("executeGate blocks a private regression (I.16)", () => {
  it("a candidate that passes public and fails a private fixture is blocked private_regression", async () => {
    const verdict = await executeGate({
      candidate: { id: "c", kind: "skill", content: "# skill" },
      seatPrompt: "seat",
      suite: SUITE,
      baseline: {
        score: 2 / 3,
        failureClusters: { "rubric_failed:s:pub1": 1 },
        fixtures: [
          { id: "s:pub1", passed: false },
          { id: "s:pub2", passed: true },
          { id: "s:priv1", passed: true },
        ],
      },
      actuals: async ({ fixtureId }) => ({ text: fixtureId, toolCalls: [], costCents: 0 }),
      judge: async ({ actual }) => ({ pass: !actual.text.includes("priv") }),
    });
    expect(verdict.promoted).toBe(false);
    expect(verdict.blockedBy).toBe("private_regression");
    expect(verdict.privateRegressions).toEqual(["s:priv1"]);
  });
});

describe("GEPA reflection never sees a private fixture (I.16)", () => {
  it("the captured reflection prompt carries the failing public fixture and not the private one", async () => {
    const store = new InMemoryImproveStore();
    const failing: TraceRecord = {
      id: "t1",
      companyId: "co",
      runId: "r",
      taskType: "general",
      agentRole: "engineer",
      stepTitle: "implement",
      status: "failed",
      toolCalls: [],
      toolCallCount: 0,
      critiqueVerdict: "retry",
      improvement: "be specific",
      costCents: 1,
      humanCorrected: false,
      createdAt: "2026-09-13T10:00:00.000Z",
    };
    const prompts: string[] = [];
    const result = await runGepaPass({
      store,
      companyId: "co",
      agentId: "engineer",
      role: "engineer",
      traces: [failing],
      suite: SUITE,
      seatPrompt: async () => "You are the engineer seat. Ship features carefully and cite evidence.",
      baseline: async () => ({
        score: 0,
        failureClusters: { "rubric_failed:s:pub1": 1, "rubric_failed:s:pub2": 1, "rubric_failed:s:priv1": 1 },
        fixtures: SUITE.fixtures.map((f) => ({ id: f.id, passed: false })),
      }),
      actuals: async () => ({ text: "x", toolCalls: [], costCents: 0 }),
      judge: async () => ({ pass: false }),
      reflect: async (prompt) => {
        prompts.push(prompt);
        return JSON.stringify({ rationale: "r", proposed_prompt: "You are the engineer seat. Ship features carefully and cite evidence. Be specific." });
      },
      skipLLM: false,
      now: "2026-09-13T10:00:00.000Z",
    });
    expect(result.skipped).toBeUndefined();
    expect(prompts.length).toBe(1);
    expect(prompts[0]).toContain("PUBLIC-ONE-TEXT");
    expect(prompts[0]).toContain("PUBLIC-TWO-TEXT");
    expect(prompts[0]).not.toContain("PRIVATE-ONE-TEXT");
    expect(prompts[0]).not.toContain("s:priv1");
  });
});
