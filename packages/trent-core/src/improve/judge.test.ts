/**
 * I.7 — the evidence-cited judge's contract, offline: the reply is parsed strictly, an
 * unparseable reply can never certify a pass, and the gateway binding sends system + user
 * messages at temperature 0 and returns integer cents.
 */
import { describe, expect, it } from "vitest";

import type { ModelGateway } from "../model-gateway/types.js";
import { createGatewayJudge, executeGate, parseJudgeReply, type FrozenSuite } from "./index.js";

describe("parseJudgeReply", () => {
  it("accepts a JSON object with a boolean pass and trims the evidence", () => {
    expect(parseJudgeReply('{"pass": true, "evidence": " split 60/40 ", "reason": "budget split present"}')).toEqual({
      pass: true,
      evidence: "split 60/40",
      reason: "budget split present",
    });
  });

  it("finds the object inside prose, and fails on anything else", () => {
    expect(parseJudgeReply('Sure: {"pass": false, "evidence": "", "reason": "no split"} hope that helps').pass).toBe(false);
    expect(parseJudgeReply("PASS").pass).toBe(false);
    expect(parseJudgeReply('{"verdict": "yes"}').pass).toBe(false);
    expect(parseJudgeReply('{"pass": "true"}').pass).toBe(false);
  });
});

describe("createGatewayJudge", () => {
  const SUITE: FrozenSuite = {
    id: "j",
    version: "v1",
    fixtures: [{ id: "j:1", prompt: "Plan the budget.", graders: [{ type: "llm_rubric", weight: 1, rubric: "Recommends a budget split." }] }],
  };

  function gatewayReplying(text: string) {
    const seen: Array<{ role: string; content: string }[]> = [];
    const temperatures: number[] = [];
    const gateway = {
      complete: async (req: { messages: Array<{ role: string; content: string }>; temperature: number }) => {
        seen.push(req.messages);
        temperatures.push(req.temperature);
        return { text, costCents: 2 };
      },
    } as unknown as ModelGateway;
    return { gateway, seen, temperatures };
  }

  it("a pass with evidence copied from the output is accepted by the gate; the prompt travels as system + user at temperature 0", async () => {
    const { gateway, seen, temperatures } = gatewayReplying('{"pass": true, "evidence": "split 60/40", "reason": "ok"}');
    const verdict = await executeGate({
      candidate: { id: "c", kind: "prompt", content: "p" },
      seatPrompt: "s",
      suite: SUITE,
      baseline: { score: 0.5, failureClusters: {} },
      actuals: async () => ({ text: "Use LinkedIn and Google; split 60/40.", costCents: 1 }),
      judge: createGatewayJudge(gateway),
    });
    expect(verdict.fixtures[0]?.score).toBe(1);
    expect(verdict.costCents).toBe(1 + 2);
    expect(temperatures).toEqual([0]);
    expect(seen[0]?.map((m) => m.role)).toEqual(["system", "user"]);
    expect(seen[0]?.[1]?.content).toContain("ASSERTION: Recommends a budget split.");
    expect(seen[0]?.[1]?.content).toContain("split 60/40");
  });

  it("a pass whose evidence is invented, or empty, is refused as judge_unverified", async () => {
    for (const reply of ['{"pass": true, "evidence": "split 70/30"}', '{"pass": true, "evidence": ""}', '{"pass": true}']) {
      const { gateway } = gatewayReplying(reply);
      const verdict = await executeGate({
        candidate: { id: "c", kind: "prompt", content: "p" },
        seatPrompt: "s",
        suite: SUITE,
        baseline: { score: 0.5, failureClusters: {} },
        actuals: async () => ({ text: "Use LinkedIn and Google; split 60/40.", costCents: 1 }),
        judge: createGatewayJudge(gateway),
      });
      expect(verdict.fixtures[0]?.score, reply).toBe(0);
      expect(verdict.failureClusters, reply).toEqual({ judge_unverified: 1 });
    }
  });
});
