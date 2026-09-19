/**
 * Task I.16, extended by [D0] gate 2 — the ONE optimise/holdout partition (CS329A L4 @31:33,
 * RLEF: public tests for iteration, private tests for the reward; L7 @36:21: the scorer must not
 * train on what it ranks). The old public/private split IS this partition, renamed: reflection
 * and the sweep's score read the optimise side, promotion eligibility is decided on the holdout.
 */
import { describe, expect, it } from "vitest";

import type { TraceRecord } from "../traces/trace-store.js";
import { executeGate } from "./gate.js";
import type { FrozenSuite } from "./suites.js";
import { runGepaPass } from "./gepa-pass.js";
import { applyMechanicalOverlay } from "./mechanical-overlay.js";
import { InMemoryImproveStore } from "./memory-store.js";
import { DEFAULT_HOLDOUT_RATIO, isHoldoutFixture, splitSuite } from "./suite-split.js";

const rubric = { type: "llm_rubric" as const, weight: 1, rubric: "Is right." };
const SUITE: FrozenSuite = {
  id: "s",
  version: "v1",
  fixtures: [
    { id: "s:pub1", prompt: "OPTIMISE-ONE-TEXT", graders: [rubric], holdout: false },
    { id: "s:pub2", prompt: "OPTIMISE-TWO-TEXT", graders: [rubric], holdout: false },
    { id: "s:priv1", prompt: "HOLDOUT-ONE-TEXT", graders: [rubric], holdout: true },
  ],
};

describe("splitSuite", () => {
  it("is deterministic per fixture id, holds out roughly 30 percent, and an explicit marker wins", () => {
    const big: FrozenSuite = { id: "big", version: "v", fixtures: Array.from({ length: 40 }, (_, i) => ({ id: `big:${i}`, prompt: `p${i}`, graders: [rubric] })) };
    const a = splitSuite(big);
    const b = splitSuite(big);
    expect(a).toEqual(b);
    expect(DEFAULT_HOLDOUT_RATIO).toBe(0.3);
    expect(a.holdout.length).toBeGreaterThanOrEqual(6);
    expect(a.holdout.length).toBeLessThanOrEqual(18);
    expect(a.optimise.length + a.holdout.length).toBe(40);
    expect(isHoldoutFixture({ id: "x", prompt: "", graders: [], holdout: true })).toBe(true);
    expect(isHoldoutFixture({ id: "x", prompt: "", graders: [], holdout: false })).toBe(false);
  });

  it("a configured ratio moves the partition and stays deterministic", () => {
    const big: FrozenSuite = { id: "big", version: "v", fixtures: Array.from({ length: 40 }, (_, i) => ({ id: `big:${i}`, prompt: `p${i}`, graders: [rubric] })) };
    const wide = splitSuite(big, 0.9);
    expect(wide.holdout.length).toBeGreaterThan(splitSuite(big, 0.3).holdout.length);
    expect(splitSuite(big, 0.9)).toEqual(wide);
  });

  it("the mechanical overlay can name the held-out ids", () => {
    const base: FrozenSuite = { id: "ads", version: "v1", fixtures: [{ id: "ads:1", prompt: "a", graders: [rubric], holdout: false }, { id: "ads:2", prompt: "b", graders: [rubric], holdout: false }] };
    const out = applyMechanicalOverlay(base, { skill_name: "ads", evals: [], holdout: [2] });
    expect(out.fixtures.map((f) => f.holdout)).toEqual([false, true]);
    expect(out.version).not.toBe(base.version);
  });
});

describe("[D0] gate 2 — promotion eligibility is decided on the holdout only", () => {
  it("a candidate that improves optimise and regresses the holdout is blocked holdout_regression", async () => {
    const verdict = await executeGate({
      candidate: { id: "c", kind: "skill", content: "# skill" },
      seatPrompt: "seat",
      suite: SUITE,
      baseline: {
        score: 2 / 3,
        failureClusters: { "rubric_failed:s:pub1": 1 },
        fixtures: [
          { id: "s:pub1", passed: false, score: 0 },
          { id: "s:pub2", passed: true, score: 1 },
          { id: "s:priv1", passed: true, score: 1 },
        ],
      },
      actuals: async ({ fixtureId }) => ({ text: fixtureId, toolCalls: [], costCents: 0 }),
      judge: async ({ actual }) => ({ pass: !actual.text.includes("priv") }),
    });
    expect(verdict.promoted).toBe(false);
    expect(verdict.blockedBy).toBe("holdout_regression");
    expect(verdict.optimise?.delta).toBeGreaterThan(0);
    expect(verdict.optimise?.score).toBe(1);
    expect(verdict.holdout?.delta).toBeLessThan(0);
    expect(verdict.holdout?.regressions).toEqual(["s:priv1"]);
  });

  it("a suite with no holdout fixture measures the holdout on the whole suite rather than skipping the check", async () => {
    const one: FrozenSuite = { id: "one", version: "v1", fixtures: [{ id: "one:a", prompt: "A", graders: [rubric], holdout: false }] };
    const verdict = await executeGate({
      candidate: { id: "c", kind: "skill", content: "# skill" },
      seatPrompt: "seat",
      suite: one,
      baseline: { score: 0, failureClusters: {}, fixtures: [{ id: "one:a", passed: false, score: 0 }] },
      actuals: async () => ({ text: "fine", toolCalls: [], costCents: 0 }),
      judge: async () => ({ pass: true }),
    });
    expect(verdict.holdout?.fixtures).toBe(1);
    expect(verdict.promoted).toBe(true);
  });
});

describe("GEPA reflection never sees a held-out fixture (I.16)", () => {
  it("the captured reflection prompt carries the failing optimise fixture and not the held-out one", async () => {
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
        fixtures: SUITE.fixtures.map((f) => ({ id: f.id, passed: false, score: 0 })),
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
    expect(prompts[0]).toContain("OPTIMISE-ONE-TEXT");
    expect(prompts[0]).toContain("OPTIMISE-TWO-TEXT");
    expect(prompts[0]).not.toContain("HOLDOUT-ONE-TEXT");
    expect(prompts[0]).not.toContain("s:priv1");
  });
});
