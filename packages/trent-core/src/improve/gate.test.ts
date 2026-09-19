/**
 * Item 3 — an eval gate that EXECUTES the candidate. Offline: the gateway is injected.
 * Deterministic graders run first and short-circuit; the LLM judge runs only when they pass.
 */
import { describe, expect, it } from "vitest";

import type { ModelGateway } from "../model-gateway/types.js";
import { emptyFrontier, updateParetoFrontier } from "../gepa/index.js";
import { createGatewayActuals, createMemoryGateCache, executeGate, measureBaseline, type FrozenSuite } from "./index.js";

const SUITE: FrozenSuite = {
  id: "ads",
  version: "v1",
  fixtures: [
    {
      id: "ads:1",
      prompt: "Plan a paid strategy for a B2B HR SaaS.",
      graders: [
        { type: "contains", weight: 1, values: ["linkedin"] },
        { type: "llm_rubric", weight: 1, rubric: "Recommends a budget split." },
      ],
    },
    {
      id: "ads:2",
      prompt: "Which tool do you call first?",
      graders: [{ type: "tool_call", weight: 1, required: ["memory:read"] }],
    },
  ],
};

/** A scripted model: the reply depends on whether the candidate skill is in the system prompt. */
function scriptedActuals(reply: (systemPrompt: string, prompt: string) => { text: string; toolCalls?: string[] }) {
  const calls: Array<{ systemPrompt: string; prompt: string }> = [];
  const actuals = async (input: { systemPrompt: string; prompt: string; fixtureId: string }) => {
    calls.push({ systemPrompt: input.systemPrompt, prompt: input.prompt });
    return { ...reply(input.systemPrompt, input.prompt), costCents: 1 };
  };
  return { actuals, calls };
}

const GOOD = (system: string) => ({
  text: system.includes("CANDIDATE") ? "Use LinkedIn first, then Google; split 60/40." : "Use LinkedIn.",
  toolCalls: ["memory:read"],
});

describe("executeGate", () => {
  it("runs every fixture WITH the candidate injected into the seat prompt, and grades the real output", async () => {
    const { actuals, calls } = scriptedActuals(GOOD);
    let judgeCalls = 0;
    const verdict = await executeGate({
      candidate: { id: "draft_1", kind: "skill", content: "# CANDIDATE skill" },
      seatPrompt: "You are the growth seat.",
      suite: SUITE,
      baseline: { score: 0.5, failureClusters: {} },
      actuals,
      judge: async () => {
        judgeCalls += 1;
        return { pass: true, score: 1 };
      },
    });
    expect(calls.length).toBe(SUITE.fixtures.length);
    for (const call of calls) {
      expect(call.systemPrompt).toContain("You are the growth seat.");
      expect(call.systemPrompt).toContain("# CANDIDATE skill");
    }
    expect(judgeCalls).toBe(1);
    expect(verdict.promoted).toBe(true);
    expect(verdict.score).toBe(1);
    expect(verdict.delta).toBe(0.5);
    expect(verdict.stage).toBe("judge");
    expect(verdict.fixtures.map((f) => f.id)).toEqual(["ads:1", "ads:2"]);
  });

  it("a candidate that makes a deterministic grader fail is rejected BEFORE any judge call", async () => {
    const { actuals } = scriptedActuals(() => ({ text: "Use Meta.", toolCalls: [] }));
    let judgeCalls = 0;
    const verdict = await executeGate({
      candidate: { id: "draft_bad", kind: "skill", content: "# CANDIDATE" },
      seatPrompt: "seat",
      suite: SUITE,
      baseline: { score: 0.5, failureClusters: {} },
      actuals,
      judge: async () => {
        judgeCalls += 1;
        return { pass: true };
      },
    });
    expect(judgeCalls).toBe(0);
    expect(verdict.promoted).toBe(false);
    expect(verdict.stage).toBe("deterministic");
    expect(verdict.blockedBy).toBe("deterministic_failure");
    expect(verdict.failureClusters).toEqual({ missing_expected_text: 1, missing_tool_call: 1 });
  });

  it("delta >= 0 with no new failure cluster promotes; a new cluster blocks even with a better score", async () => {
    const { actuals } = scriptedActuals(GOOD);
    const tie = await executeGate({
      candidate: { id: "c", kind: "skill", content: "CANDIDATE" },
      seatPrompt: "seat",
      suite: SUITE,
      baseline: { score: 1, failureClusters: {} },
      actuals,
      judge: async () => ({ pass: true }),
    });
    expect(tie.promoted).toBe(true);
    expect(tie.delta).toBe(0);

    const newCluster = await executeGate({
      candidate: { id: "c", kind: "skill", content: "CANDIDATE" },
      seatPrompt: "seat",
      suite: SUITE,
      baseline: { score: 0.2, failureClusters: {} },
      actuals,
      judge: async () => ({ pass: false, reason: "no split" }),
    });
    expect(newCluster.promoted).toBe(false);
    expect(newCluster.blockedBy).toBe("new_failure_cluster");
    expect(newCluster.failureClusters).toEqual({ "rubric_failed:ads:1": 1 });
  });

  it("a prompt candidate is swapped in for the seat prompt rather than appended", async () => {
    const { actuals, calls } = scriptedActuals(GOOD);
    await executeGate({
      candidate: { id: "gepa_1", kind: "prompt", content: "CANDIDATE prompt v2" },
      seatPrompt: "ORIGINAL seat prompt",
      suite: SUITE,
      baseline: { score: 0, failureClusters: {} },
      actuals,
    });
    for (const call of calls) {
      expect(call.systemPrompt).toBe("CANDIDATE prompt v2");
    }
  });

  it("I.5: with no judge injected a rubric-only verdict is UNVERIFIED and cannot promote (the vacuous gate)", async () => {
    const { actuals } = scriptedActuals(GOOD);
    const verdict = await executeGate({
      candidate: { id: "c", kind: "skill", content: "CANDIDATE" },
      seatPrompt: "seat",
      suite: SUITE,
      baseline: { score: 0.5, failureClusters: { llm_judge_pending: 1 } },
      actuals,
    });
    expect(verdict.judgeCalls).toBe(0);
    expect(verdict.failureClusters).toEqual({ llm_judge_pending: 1 });
    expect(verdict.promoted).toBe(false);
    expect(verdict.blockedBy).toBe("unverified");
  });

  it("I.5: a suite with only mechanical graders needs no judge and is still promotable", async () => {
    const { actuals } = scriptedActuals(GOOD);
    const mechanical: FrozenSuite = { id: "m", version: "v1", fixtures: [SUITE.fixtures[1]!] };
    const verdict = await executeGate({
      candidate: { id: "c", kind: "skill", content: "CANDIDATE" },
      seatPrompt: "seat",
      suite: mechanical,
      baseline: { score: 1, failureClusters: {} },
      actuals,
    });
    expect(verdict.promoted).toBe(true);
    expect(verdict.blockedBy).toBeUndefined();
  });

  it("I.4: a fixture whose candidate output is byte-identical to the baseline output makes zero judge calls", async () => {
    // The reply ignores the system prompt, so candidate and baseline outputs hash equal on every fixture.
    const { actuals } = scriptedActuals(() => ({ text: "Use LinkedIn; split 60/40.", toolCalls: ["memory:read"] }));
    const cache = createMemoryGateCache();
    let judgeCalls = 0;
    const judge = async () => {
      judgeCalls += 1;
      return { pass: true, costCents: 1 };
    };
    const baseline = await measureBaseline({ seatPrompt: "seat", suite: SUITE, actuals, judge, cache });
    expect(judgeCalls).toBe(1);
    expect(baseline.costCents).toBe(SUITE.fixtures.length + 1);

    judgeCalls = 0;
    const verdict = await executeGate({
      candidate: { id: "c", kind: "skill", content: "CANDIDATE" },
      seatPrompt: "seat",
      suite: SUITE,
      baseline,
      actuals,
      judge,
      cache,
    });
    expect(judgeCalls).toBe(0);
    expect(verdict.judgeCalls).toBe(0);
    expect(verdict.promoted).toBe(true);
    expect(verdict.stage).toBe("judge");
    // A changed output is judged again: the memo is keyed by the output hash, not the fixture alone.
    const changed = scriptedActuals((system) => ({ text: system.includes("CANDIDATE") ? "Use LinkedIn; split 70/30." : "x", toolCalls: ["memory:read"] }));
    await executeGate({ candidate: { id: "c2", kind: "skill", content: "CANDIDATE" }, seatPrompt: "seat", suite: SUITE, baseline, actuals: changed.actuals, judge, cache });
    expect(judgeCalls).toBe(1);
  });

  it("judge cost is part of the gate's cost, and calls are reported per kind", async () => {
    const { actuals } = scriptedActuals(GOOD);
    const verdict = await executeGate({
      candidate: { id: "c", kind: "skill", content: "CANDIDATE" },
      seatPrompt: "seat",
      suite: SUITE,
      baseline: { score: 0.5, failureClusters: {} },
      actuals,
      judge: async () => ({ pass: true, costCents: 3 }),
    });
    expect(verdict.actualsCalls).toBe(2);
    expect(verdict.judgeCalls).toBe(1);
    expect(verdict.costCents).toBe(2 + 3);
  });
});

describe("evidence-cited judge (I.7)", () => {
  it("a pass whose cited evidence is not in the output scores 0 with tag judge_unverified, in the same call", async () => {
    const { actuals } = scriptedActuals(GOOD);
    let judgeCalls = 0;
    const verdict = await executeGate({
      candidate: { id: "c", kind: "skill", content: "CANDIDATE" },
      seatPrompt: "seat",
      suite: SUITE,
      baseline: { score: 0.5, failureClusters: {} },
      actuals,
      judge: async () => {
        judgeCalls += 1;
        return { pass: true, evidence: "not in output" };
      },
    });
    expect(judgeCalls).toBe(1);
    const first = verdict.fixtures.find((f) => f.id === "ads:1")!;
    expect(first.score).toBe(0.5);
    expect(first.failureTags).toEqual(["judge_unverified"]);
    expect(verdict.failureClusters).toEqual({ judge_unverified: 1 });
    expect(verdict.promoted).toBe(false);
  });

  it("a pass whose evidence IS a substring of the output is accepted", async () => {
    const { actuals } = scriptedActuals(GOOD);
    const verdict = await executeGate({
      candidate: { id: "c", kind: "skill", content: "CANDIDATE" },
      seatPrompt: "seat",
      suite: SUITE,
      baseline: { score: 0.5, failureClusters: {} },
      actuals,
      judge: async () => ({ pass: true, evidence: "split 60/40" }),
    });
    expect(verdict.fixtures.find((f) => f.id === "ads:1")!.score).toBe(1);
    expect(verdict.promoted).toBe(true);
  });
});

describe("per-fixture failure tags (I.9)", () => {
  const TWO: FrozenSuite = {
    id: "two",
    version: "v1",
    fixtures: [
      { id: "two:a", prompt: "A", graders: [{ type: "llm_rubric", weight: 1, rubric: "ok" }] },
      { id: "two:b", prompt: "B", graders: [{ type: "llm_rubric", weight: 1, rubric: "ok" }] },
    ],
  };

  it("two candidates failing DIFFERENT fixtures occupy two frontier slots", async () => {
    const { actuals } = scriptedActuals(() => ({ text: "x" }));
    const failOn = (fixture: string) => async (input: { prompt: string }) => ({ pass: input.prompt !== fixture });
    const a = await executeGate({ candidate: { id: "a", kind: "prompt", content: "A" }, seatPrompt: "s", suite: TWO, baseline: { score: 0, failureClusters: {} }, actuals, judge: failOn("A") });
    const b = await executeGate({ candidate: { id: "b", kind: "prompt", content: "B" }, seatPrompt: "s", suite: TWO, baseline: { score: 0, failureClusters: {} }, actuals, judge: failOn("B") });
    expect(a.failureClusters).toEqual({ "rubric_failed:two:a": 1 });
    expect(b.failureClusters).toEqual({ "rubric_failed:two:b": 1 });
    const toCandidate = (id: string, v: typeof a) => ({ id, roleId: "growth" as const, proposedPrompt: id, reflectionRationale: "", score: v.score, delta: v.delta, failureClusters: v.failureClusters, createdAt: "t" });
    const frontier = updateParetoFrontier(updateParetoFrontier(emptyFrontier("growth", "t"), toCandidate("a", a)), toCandidate("b", b));
    expect(frontier.candidates.length).toBe(2);
  });
});

describe("second-draw reliability (I.12)", () => {
  const RUBRIC_SUITE: FrozenSuite = {
    id: "r",
    version: "v1",
    fixtures: [
      { id: "r:1", prompt: "one", graders: [{ type: "llm_rubric", weight: 1, rubric: "ok" }] },
      { id: "r:2", prompt: "two", graders: [{ type: "llm_rubric", weight: 1, rubric: "ok" }] },
    ],
  };

  it("a fixture that flipped to pass on draw 1 and fails on draw 2 blocks with 'unstable'; unflipped fixtures are not re-run", async () => {
    const calls: Array<{ prompt: string; temperature?: number }> = [];
    const actuals = async (input: { prompt: string; temperature?: number }) => {
      calls.push({ prompt: input.prompt, ...(input.temperature === undefined ? {} : { temperature: input.temperature }) });
      // Fixture "one": draw 1 says GOOD, draw 2 says BAD. Fixture "two": always GOOD.
      const draws = calls.filter((c) => c.prompt === input.prompt).length;
      return { text: input.prompt === "one" && draws > 1 ? "BAD" : "GOOD", costCents: 1 };
    };
    let judgeCalls = 0;
    const judge = async (input: { actual: { text: string } }) => {
      judgeCalls += 1;
      return { pass: input.actual.text === "GOOD", evidence: input.actual.text, costCents: 1 };
    };
    // Baseline: fixture one failed, fixture two passed. The candidate flips ONLY fixture one.
    const baseline = { score: 0.5, failureClusters: { "rubric_failed:r:1": 1 }, fixtures: [{ id: "r:1", passed: false }, { id: "r:2", passed: true }] };
    const verdict = await executeGate({ candidate: { id: "c", kind: "prompt", content: "P" }, seatPrompt: "s", suite: RUBRIC_SUITE, baseline, actuals, judge });
    expect(verdict.promoted).toBe(false);
    expect(verdict.blockedBy).toBe("unstable");
    expect(calls.filter((c) => c.prompt === "one").length).toBe(2);
    expect(calls.filter((c) => c.prompt === "two").length).toBe(1);
    expect(calls[2]?.temperature).toBe(0.7);
    expect(verdict.redraw).toEqual({ fixtures: ["r:1"], actualsCalls: 1, judgeCalls: 1, unstable: ["r:1"] });
    expect(verdict.actualsCalls).toBe(3);
    expect(judgeCalls).toBe(3);
    expect(verdict.costCents).toBe(3 + 3);
  });

  it("a flip that holds on the second draw promotes", async () => {
    const actuals = async (input: { prompt: string }) => ({ text: "GOOD", costCents: 1 });
    const judge = async () => ({ pass: true, evidence: "GOOD" });
    const baseline = { score: 0.5, failureClusters: { "rubric_failed:r:1": 1 }, fixtures: [{ id: "r:1", passed: false }, { id: "r:2", passed: true }] };
    const verdict = await executeGate({ candidate: { id: "c", kind: "prompt", content: "P" }, seatPrompt: "s", suite: RUBRIC_SUITE, baseline, actuals, judge });
    expect(verdict.promoted).toBe(true);
    expect(verdict.redraw?.fixtures).toEqual(["r:1"]);
    expect(verdict.redraw?.unstable).toEqual([]);
  });

  it("measureBaseline reports per-fixture pass/fail AND score, so flips and the partition can be computed", async () => {
    const actuals = async (input: { prompt: string }) => ({ text: input.prompt === "one" ? "BAD" : "GOOD", costCents: 1 });
    const baseline = await measureBaseline({ seatPrompt: "s", suite: RUBRIC_SUITE, actuals, judge: async (i) => ({ pass: i.actual.text === "GOOD" }) });
    expect(baseline.fixtures).toEqual([{ id: "r:1", passed: false, score: 0 }, { id: "r:2", passed: true, score: 1 }]);
  });
});

describe("createGatewayActuals", () => {
  it("sends system + user messages through the gateway and returns integer cents, never logging the prompt body", async () => {
    const seen: Array<{ role: string; content: string }[]> = [];
    const gateway = {
      complete: async (req: { messages: Array<{ role: string; content: string }> }) => {
        seen.push(req.messages);
        return { text: "hello", provider: "google", model: "m", modelTier: "haiku", inputTokens: 3, outputTokens: 1, costCents: 2, estimated: true, finishReason: "stop" };
      },
    } as unknown as ModelGateway;
    const actuals = createGatewayActuals(gateway);
    const out = await actuals({ systemPrompt: "SYS", prompt: "USER", fixtureId: "f" });
    expect(out).toEqual({ text: "hello", toolCalls: [], costCents: 2 });
    expect(seen).toEqual([[{ role: "system", content: "SYS" }, { role: "user", content: "USER" }]]);
  });

  it("extracts tool calls from a JSON tool-use turn", async () => {
    const gateway = {
      complete: async () => ({ text: JSON.stringify({ toolCall: { name: "memory", action: "read" }, summary: null }), costCents: 1 }),
    } as unknown as ModelGateway;
    const out = await createGatewayActuals(gateway)({ systemPrompt: "s", prompt: "p", fixtureId: "f" });
    expect(out.toolCalls).toEqual(["memory:read"]);
  });
});
