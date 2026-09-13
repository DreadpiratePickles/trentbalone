/**
 * Item 3 — an eval gate that EXECUTES the candidate. Offline: the gateway is injected.
 * Deterministic graders run first and short-circuit; the LLM judge runs only when they pass.
 */
import { describe, expect, it } from "vitest";

import type { ModelGateway } from "../model-gateway/types.js";
import { createGatewayActuals, executeGate, type FrozenSuite } from "./index.js";

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
    expect(newCluster.failureClusters).toEqual({ rubric_failed: 1 });
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

  it("with no judge injected, rubric graders stay pending and are tagged as such", async () => {
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
    expect(verdict.promoted).toBe(true);
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
