import { describe, it, expect } from "vitest";
import { emptyFrontier, updateParetoFrontier, worstPerformingRole, type GEPACandidate } from "./index.js";

function candidate(
  id: string,
  score: number,
  failureClusters: Record<string, number>,
): GEPACandidate {
  return {
    id,
    roleId: "engineer",
    proposedPrompt: `prompt-${id}`,
    reflectionRationale: `rationale-${id}`,
    score,
    delta: 0,
    failureClusters,
    createdAt: "2026-09-01T00:00:00.000Z",
  };
}

describe("gepa wrapper — Pareto frontier (pure, offline)", () => {
  it("keeps one candidate per failure profile, the best of each, and never mutates its input", () => {
    const a = candidate("A", 0.6, { missing_tool_call: 2 });
    const b = candidate("B", 0.9, { missing_tool_call: 5 });
    const c = candidate("C", 0.7, {});

    const start = emptyFrontier("engineer", "2026-09-01T00:00:00.000Z");
    const afterA = updateParetoFrontier(start, a);
    const afterB = updateParetoFrontier(afterA, b);
    const afterC = updateParetoFrontier(afterB, c);

    expect(afterC.candidates).toHaveLength(2);
    expect(afterC.best?.id).toBe("B");
    expect(afterC.candidates.map((x) => x.id).sort()).toEqual(["B", "C"]);

    // The originals are untouched — every update returns a fresh frontier.
    expect(start.candidates).toHaveLength(0);
    expect(start.best).toBeNull();
    expect(afterA.candidates.map((x) => x.id)).toEqual(["A"]);
    expect(afterA.best?.id).toBe("A");
    expect(afterB.candidates.map((x) => x.id)).toEqual(["B"]);
  });

  it("does not displace a same-profile candidate that already scores higher", () => {
    const strong = candidate("STRONG", 0.95, { missing_tool_call: 1 });
    const weak = candidate("WEAK", 0.2, { missing_tool_call: 9 });
    const frontier = updateParetoFrontier(
      updateParetoFrontier(emptyFrontier("engineer"), strong),
      weak,
    );
    expect(frontier.candidates.map((x) => x.id)).toEqual(["STRONG"]);
  });

  it("caps the frontier at maxSize, keeping the highest scorers", () => {
    let frontier = emptyFrontier("engineer");
    for (const [i, score] of [0.1, 0.5, 0.9].entries()) {
      frontier = updateParetoFrontier(frontier, candidate(`c${i}`, score, { [`tag${i}`]: 1 }), 2);
    }
    expect(frontier.candidates).toHaveLength(2);
    expect(frontier.candidates.map((x) => x.score).sort()).toEqual([0.5, 0.9]);
    expect(frontier.best?.score).toBe(0.9);
  });

  it("names the worst-scoring role across traces and null when no trace is scored", () => {
    const base = {
      companyId: "co_1",
      runId: "run1",
      taskType: "t",
      stepTitle: "s",
      status: "completed" as const,
      toolCalls: [],
      toolCallCount: 0,
      costCents: 0,
      humanCorrected: false,
      createdAt: "2026-09-01T00:00:00.000Z",
    };
    expect(
      worstPerformingRole([
        { ...base, id: "1", agentRole: "engineer", evalScore: 0.9 },
        { ...base, id: "2", agentRole: "growth", evalScore: 0.2 },
      ]),
    ).toBe("growth");
    expect(worstPerformingRole([{ ...base, id: "3", agentRole: "engineer" }])).toBeNull();
    expect(worstPerformingRole([])).toBeNull();
  });
});
