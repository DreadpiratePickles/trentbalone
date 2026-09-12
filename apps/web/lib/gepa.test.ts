import { describe, it, expect } from "vitest";
import {
  buildReflectionPrompt,
  parseReflectionResponse,
  updateParetoFrontier,
  worstPerformingRole,
  evolveRolePrompt,
  emptyFrontier,
  type GEPACandidate,
  type GEPAFrontier,
} from "@/lib/gepa";
import type { TraceRecord } from "@/lib/trace-store";
import type { EvalSuiteInput } from "@/lib/eval-harness";

const FIXED_NOW = "2026-06-02T12:00:00.000Z";

function trace(overrides: Partial<TraceRecord> = {}): TraceRecord {
  return {
    id: "t1",
    companyId: "c1",
    runId: "r1",
    taskType: "churn_analysis",
    agentRole: "analyst",
    stepTitle: "Analyze cohorts",
    status: "failed",
    toolCalls: [],
    toolCallCount: 0,
    costCents: 5,
    humanCorrected: false,
    createdAt: FIXED_NOW,
    critiqueVerdict: "retry",
    improvement: "pull retention metrics first",
    ...overrides,
  };
}

function candidate(overrides: Partial<GEPACandidate> = {}): GEPACandidate {
  return {
    id: "c1",
    roleId: "analyst",
    proposedPrompt: "new prompt",
    reflectionRationale: "reasoning",
    score: 0.8,
    delta: 0.1,
    failureClusters: {},
    createdAt: FIXED_NOW,
    ...overrides,
  };
}

function passingSuite(): Omit<EvalSuiteInput, "subjectId" | "previousScore"> {
  return {
    subjectType: "seat",
    version: "v1",
    fixtures: [
      {
        id: "f1",
        rubricId: "r1",
        input: "test",
        actual: { text: "test output" },
        graders: [{ type: "contains", weight: 1, values: ["test"] }],
      },
    ],
  };
}

describe("buildReflectionPrompt", () => {
  it("includes the role name and current prompt", () => {
    const prompt = buildReflectionPrompt("analyst", "You are an analyst.", [trace()]);
    expect(prompt).toContain("analyst");
    expect(prompt).toContain("You are an analyst.");
  });

  it("includes improvement notes from failing traces", () => {
    const prompt = buildReflectionPrompt("analyst", "prompt", [trace({ improvement: "pull retention first" })]);
    expect(prompt).toContain("pull retention first");
  });

  it("caps traces at 20 to avoid token overflow", () => {
    const traces = Array.from({ length: 30 }, (_, i) => trace({ id: `t${i}` }));
    const prompt = buildReflectionPrompt("analyst", "prompt", traces);
    // Trace 21 should not appear
    expect(prompt).not.toContain("Trace 21:");
    expect(prompt).toContain("Trace 20:");
  });

  it("requests JSON output format", () => {
    const prompt = buildReflectionPrompt("analyst", "prompt", [trace()]);
    expect(prompt).toContain("proposed_prompt");
    expect(prompt).toContain("rationale");
  });
});

describe("parseReflectionResponse", () => {
  it("parses a well-formed reflection response", () => {
    const raw = JSON.stringify({ rationale: "Added context", proposed_prompt: "new prompt text" });
    const r = parseReflectionResponse(raw, "fallback");
    expect(r.rationale).toBe("Added context");
    expect(r.proposedPrompt).toBe("new prompt text");
  });

  it("extracts JSON from surrounding prose", () => {
    const raw = 'Here is the revised prompt:\n{"rationale":"fix","proposed_prompt":"better prompt"}';
    const r = parseReflectionResponse(raw, "fallback");
    expect(r.proposedPrompt).toBe("better prompt");
  });

  it("falls back to the current prompt on malformed JSON", () => {
    const r = parseReflectionResponse("not json at all", "current prompt");
    expect(r.proposedPrompt).toBe("current prompt");
    expect(r.rationale).toContain("failed");
  });

  it("falls back on missing required fields", () => {
    const raw = JSON.stringify({ rationale: "only rationale" });
    const r = parseReflectionResponse(raw, "fallback");
    expect(r.proposedPrompt).toBe("fallback");
  });
});

describe("updateParetoFrontier", () => {
  it("adds the first candidate to an empty frontier", () => {
    const f = emptyFrontier("analyst", FIXED_NOW);
    const updated = updateParetoFrontier(f, candidate());
    expect(updated.candidates).toHaveLength(1);
    expect(updated.best?.id).toBe("c1");
  });

  it("replaces a same-cluster candidate with a higher scorer", () => {
    const f = emptyFrontier("analyst", FIXED_NOW);
    const initial = updateParetoFrontier(f, candidate({ id: "low", score: 0.6, failureClusters: {} }));
    const updated = updateParetoFrontier(initial, candidate({ id: "high", score: 0.9, failureClusters: {} }));
    expect(updated.candidates).toHaveLength(1);
    expect(updated.best?.id).toBe("high");
  });

  it("does NOT replace a same-cluster candidate with a lower scorer", () => {
    const f = emptyFrontier("analyst", FIXED_NOW);
    const initial = updateParetoFrontier(f, candidate({ id: "high", score: 0.9, failureClusters: {} }));
    const updated = updateParetoFrontier(initial, candidate({ id: "low", score: 0.5, failureClusters: {} }));
    expect(updated.candidates).toHaveLength(1);
    expect(updated.best?.id).toBe("high");
  });

  it("keeps candidates with different failure profiles (diversity)", () => {
    const f = emptyFrontier("analyst", FIXED_NOW);
    const first = updateParetoFrontier(f, candidate({ id: "c1", score: 0.8, failureClusters: {} }));
    const second = updateParetoFrontier(
      first,
      candidate({ id: "c2", score: 0.7, failureClusters: { missing_tool_call: 1 } }),
    );
    expect(second.candidates).toHaveLength(2);
  });

  it("trims to maxSize by dropping the lowest scorer", () => {
    let f = emptyFrontier("analyst", FIXED_NOW);
    for (let i = 0; i < 7; i++) {
      f = updateParetoFrontier(
        f,
        candidate({ id: `c${i}`, score: i * 0.1, failureClusters: { [`cluster_${i}`]: 1 } }),
        3,
      );
    }
    expect(f.candidates).toHaveLength(3);
    // Should keep the top 3 scorers
    expect(f.candidates.every((c) => c.score >= 0.4)).toBe(true);
  });

  it("updates 'best' to the highest-scoring candidate", () => {
    const f = emptyFrontier("analyst", FIXED_NOW);
    let updated = updateParetoFrontier(f, candidate({ id: "mid", score: 0.7, failureClusters: {} }));
    updated = updateParetoFrontier(updated, candidate({ id: "top", score: 0.95, failureClusters: { a: 1 } }));
    expect(updated.best?.id).toBe("top");
  });
});

describe("worstPerformingRole", () => {
  it("returns null for empty traces", () => {
    expect(worstPerformingRole([])).toBeNull();
  });

  it("returns null when no traces have evalScores", () => {
    expect(worstPerformingRole([trace({ evalScore: undefined })])).toBeNull();
  });

  it("identifies the role with the lowest average score", () => {
    const traces = [
      trace({ agentRole: "analyst", evalScore: 0.9 }),
      trace({ id: "t2", agentRole: "engineer", evalScore: 0.3 }),
      trace({ id: "t3", agentRole: "engineer", evalScore: 0.4 }),
    ];
    expect(worstPerformingRole(traces)).toBe("engineer");
  });

  it("handles a single role across all traces", () => {
    const traces = [
      trace({ evalScore: 0.5 }),
      trace({ id: "t2", evalScore: 0.6 }),
    ];
    expect(worstPerformingRole(traces)).toBe("analyst");
  });
});

describe("evolveRolePrompt", () => {
  const baseline = { score: 0.8, failureClusters: {} };

  it("returns null when there are no failing traces", async () => {
    const f = emptyFrontier("analyst", FIXED_NOW);
    const result = await evolveRolePrompt(
      "analyst", "prompt", [], passingSuite(), baseline, f, { skipLLM: true },
    );
    expect(result).toBeNull();
  });

  it("returns an updated frontier on success", async () => {
    const f = emptyFrontier("analyst", FIXED_NOW);
    const result = await evolveRolePrompt(
      "analyst", "current prompt", [trace()], passingSuite(), baseline, f,
      { skipLLM: true, id: "fixed-id", now: FIXED_NOW },
    );
    expect(result).not.toBeNull();
    expect(result!.frontier.candidates).toHaveLength(1);
    expect(result!.frontier.candidates[0].id).toBe("fixed-id");
  });

  it("emits an eval gate decision for the proposed prompt", async () => {
    const f = emptyFrontier("analyst", FIXED_NOW);
    const result = await evolveRolePrompt(
      "analyst", "current prompt", [trace()], passingSuite(), baseline, f,
      { skipLLM: true },
    );
    expect(result!.decision.result.subjectType).toBe("seat");
    expect(typeof result!.decision.score).toBe("number");
  });

  it("sets the proposed prompt to a modified version (skipLLM mode)", async () => {
    const f = emptyFrontier("analyst", FIXED_NOW);
    const result = await evolveRolePrompt(
      "analyst", "original", [trace()], passingSuite(), baseline, f, { skipLLM: true },
    );
    expect(result!.frontier.best?.proposedPrompt).toContain("original");
    expect(result!.frontier.best?.proposedPrompt).toContain("gepa evolved");
  });
});

describe("emptyFrontier", () => {
  it("creates an empty frontier with correct role", () => {
    const f = emptyFrontier("engineer", FIXED_NOW);
    expect(f.roleId).toBe("engineer");
    expect(f.candidates).toHaveLength(0);
    expect(f.best).toBeNull();
    expect(f.updatedAt).toBe(FIXED_NOW);
  });
});
