/**
 * [D0] gate 3 — pass^k.
 *
 * One draw per fixture promotes coin flips (design review section 6, item 6; CS329A G12). A
 * fixture counts as passed only if it passes k CONSECUTIVE trials, and the trials share nothing:
 * each one runs the suite again through the runner with its own trial number and its own judge
 * calls, so a memoised verdict from trial 1 can never carry trial 3.
 */
import { describe, expect, it } from "vitest";

import { executeGate, measureBaseline } from "./gate.js";
import { createMemoryGateCache } from "./gate-cache.js";
import { DEFAULT_PASS_K } from "./pass-k.js";
import type { FrozenSuite } from "./suites.js";

const SUITE: FrozenSuite = {
  id: "k",
  version: "v1",
  fixtures: [{ id: "k:1", prompt: "one", graders: [{ type: "llm_rubric", weight: 1, rubric: "Is right." }] }],
};

describe("[D0] pass^k", () => {
  it("defaults to three trials", () => {
    expect(DEFAULT_PASS_K).toBe(3);
  });

  it("a flaky fixture that passes 2 of 3 trials fails the gate", async () => {
    const trials: number[] = [];
    const verdict = await executeGate({
      candidate: { id: "c", kind: "prompt", content: "P" },
      seatPrompt: "seat",
      suite: SUITE,
      baseline: { score: 0, failureClusters: {}, fixtures: [{ id: "k:1", passed: false, score: 0 }] },
      passK: 3,
      actuals: async ({ trial }) => {
        trials.push(trial ?? 1);
        return { text: trial === 3 ? "wrong" : "right", toolCalls: [], costCents: 1 };
      },
      judge: async ({ actual }) => ({ pass: actual.text === "right" }),
    });
    expect(trials).toEqual([1, 2, 3]);
    expect(verdict.trials).toBe(3);
    expect(verdict.fixtures[0]?.passed).toBe(false);
    expect(verdict.promoted).toBe(false);
    // Cost and calls are the sum of the trials, so the meter sees what pass^k really spends.
    expect(verdict.actualsCalls).toBe(3);
    expect(verdict.costCents).toBe(3);
  });

  it("a fixture that passes all k trials still passes, and the gate promotes", async () => {
    const verdict = await executeGate({
      candidate: { id: "c", kind: "prompt", content: "P" },
      seatPrompt: "seat",
      suite: SUITE,
      baseline: { score: 0, failureClusters: {}, fixtures: [{ id: "k:1", passed: false, score: 0 }] },
      passK: 3,
      actuals: async () => ({ text: "right", toolCalls: [], costCents: 0 }),
      judge: async () => ({ pass: true }),
    });
    expect(verdict.fixtures[0]?.passed).toBe(true);
    expect(verdict.promoted).toBe(true);
  });

  it("trials are isolated: a cached judge verdict from trial 1 is never reused by trial 2", async () => {
    const cache = createMemoryGateCache();
    let judgeCalls = 0;
    await executeGate({
      candidate: { id: "c", kind: "prompt", content: "P" },
      seatPrompt: "seat",
      suite: SUITE,
      baseline: { score: 0, failureClusters: {} },
      passK: 3,
      cache,
      actuals: async () => ({ text: "identical output", toolCalls: [], costCents: 0 }),
      judge: async () => {
        judgeCalls += 1;
        return { pass: true };
      },
    });
    expect(judgeCalls).toBe(3);
  });

  it("the baseline is measured under the same k, so a candidate is never compared to a one-draw baseline", async () => {
    const trials: number[] = [];
    const measured = await measureBaseline({
      seatPrompt: "seat",
      suite: SUITE,
      passK: 3,
      actuals: async ({ trial }) => {
        trials.push(trial ?? 1);
        return { text: trial === 2 ? "wrong" : "right", toolCalls: [], costCents: 0 };
      },
      judge: async ({ actual }) => ({ pass: actual.text === "right" }),
    });
    expect(trials).toEqual([1, 2, 3]);
    expect(measured.fixtures[0]?.passed).toBe(false);
  });

  it("k of one is one trial, so a caller that wants a single draw still gets one", async () => {
    const trials: number[] = [];
    await executeGate({
      candidate: { id: "c", kind: "prompt", content: "P" },
      seatPrompt: "seat",
      suite: SUITE,
      baseline: { score: 0, failureClusters: {} },
      passK: 1,
      actuals: async ({ trial }) => {
        trials.push(trial ?? 1);
        return { text: "right", toolCalls: [], costCents: 0 };
      },
      judge: async () => ({ pass: true }),
    });
    expect(trials).toEqual([1]);
  });
});
