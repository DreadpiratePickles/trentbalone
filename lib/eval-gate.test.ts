import { describe, it, expect } from "vitest";
import {
  hasNewFailureCluster,
  promoteCandidate,
  type EvalGateBaseline,
  type EvalGateCandidate,
} from "@/lib/eval-gate";
import type { EvalSuiteInput } from "@/lib/eval-harness";

const CANDIDATE: EvalGateCandidate = { id: "skill_draft_1", type: "skill", version: "1.0.0" };

function passingSuite(): Omit<EvalSuiteInput, "subjectId" | "previousScore"> {
  return {
    subjectType: "seat",
    version: "v1",
    fixtures: [
      {
        id: "f1",
        rubricId: "r1",
        input: "test",
        actual: { text: "test result" },
        graders: [{ type: "contains", weight: 1, values: ["test"] }],
      },
    ],
  };
}

function failingSuite(): Omit<EvalSuiteInput, "subjectId" | "previousScore"> {
  return {
    subjectType: "seat",
    version: "v1",
    fixtures: [
      {
        id: "f1",
        rubricId: "r1",
        input: "test",
        actual: { text: "wrong output" },
        graders: [{ type: "contains", weight: 1, values: ["MISSING_TOKEN"] }],
      },
    ],
  };
}

function mixedSuite(): Omit<EvalSuiteInput, "subjectId" | "previousScore"> {
  // score=0.5, introduces "missing_expected_text" cluster
  return {
    subjectType: "seat",
    version: "v1",
    fixtures: [
      {
        id: "f1",
        rubricId: "r1",
        input: "test",
        actual: { text: "partial" },
        graders: [
          { type: "contains", weight: 1, values: ["partial"] },
          { type: "contains", weight: 1, values: ["MISSING_TOKEN"] },
        ],
      },
    ],
  };
}

describe("hasNewFailureCluster", () => {
  it("returns false when current has no keys absent from baseline", () => {
    expect(hasNewFailureCluster({ a: 1, b: 2 }, { a: 0, b: 0, c: 3 })).toBe(false);
  });

  it("returns true when current introduces a key not in baseline", () => {
    expect(hasNewFailureCluster({ a: 1, new_cluster: 1 }, { a: 1 })).toBe(true);
  });

  it("returns false for empty current clusters", () => {
    expect(hasNewFailureCluster({}, { a: 1 })).toBe(false);
  });

  it("returns false when both are empty", () => {
    expect(hasNewFailureCluster({}, {})).toBe(false);
  });
});

describe("promoteCandidate", () => {
  const baseline: EvalGateBaseline = { score: 0.8, failureClusters: {} };

  it("promotes a candidate that beats the baseline", async () => {
    const d = await promoteCandidate(CANDIDATE, passingSuite(), baseline);
    expect(d.promoted).toBe(true);
    expect(d.delta).toBeGreaterThanOrEqual(0);
    expect(d.blockedBy).toBeUndefined();
  });

  it("promotes a candidate that ties the baseline score", async () => {
    const tieBaseline: EvalGateBaseline = { score: 1.0, failureClusters: {} };
    const d = await promoteCandidate(CANDIDATE, passingSuite(), tieBaseline);
    expect(d.promoted).toBe(true);
    expect(d.delta).toBe(0);
  });

  it("blocks promotion when delta < 0 (regression)", async () => {
    const highBaseline: EvalGateBaseline = { score: 1.0, failureClusters: {} };
    const d = await promoteCandidate(CANDIDATE, failingSuite(), highBaseline);
    expect(d.promoted).toBe(false);
    expect(d.blockedBy).toBe("regression");
    expect(d.delta).toBeLessThan(0);
  });

  it("blocks promotion when a new failure-cluster category appears (delta = 0)", async () => {
    // mixed suite → score 0.5, introduces "missing_expected_text"; baseline score 0.5, no clusters
    const cleanBaseline: EvalGateBaseline = { score: 0.5, failureClusters: {} };
    const d = await promoteCandidate(CANDIDATE, mixedSuite(), cleanBaseline);
    expect(d.promoted).toBe(false);
    expect(d.blockedBy).toBe("new_failure_cluster");
    expect(d.delta).toBe(0);
  });

  it("allows a new failure cluster when it already existed in baseline", async () => {
    // baseline already acknowledges "missing_expected_text" — candidate is not making it worse
    const acknowledgedBaseline: EvalGateBaseline = {
      score: 0.5,
      failureClusters: { missing_expected_text: 1 },
    };
    const d = await promoteCandidate(CANDIDATE, mixedSuite(), acknowledgedBaseline);
    expect(d.promoted).toBe(true);
  });

  it("populates the full EvalSuiteResult on every decision", async () => {
    const d = await promoteCandidate(CANDIDATE, passingSuite(), baseline);
    expect(d.result.subjectId).toBe(CANDIDATE.id);
    expect(d.result.score).toBeGreaterThanOrEqual(0);
    expect(typeof d.result.failureClusters).toBe("object");
  });

  it("computes delta from baseline when result.delta is defined", async () => {
    const d = await promoteCandidate(CANDIDATE, passingSuite(), baseline);
    expect(typeof d.delta).toBe("number");
    expect(Number.isFinite(d.delta)).toBe(true);
  });
});

describe("promoteCandidate — strict-improvement mode (Slice 2)", () => {
  it("blocks a tie when requireStrictImprovement is on (must beat, not match)", async () => {
    const tieBaseline: EvalGateBaseline = { score: 1.0, failureClusters: {} };
    const d = await promoteCandidate(CANDIDATE, passingSuite(), tieBaseline, {
      requireStrictImprovement: true,
    });
    expect(d.promoted).toBe(false);
    expect(d.blockedBy).toBe("no_improvement");
    expect(d.delta).toBe(0);
  });

  it("promotes a strictly-better candidate under strict mode", async () => {
    const lowBaseline: EvalGateBaseline = { score: 0.0, failureClusters: {} };
    const d = await promoteCandidate(CANDIDATE, passingSuite(), lowBaseline, {
      requireStrictImprovement: true,
    });
    expect(d.promoted).toBe(true);
    expect(d.delta).toBeGreaterThan(0);
  });

  it("still blocks a regression under strict mode (regression takes priority)", async () => {
    const highBaseline: EvalGateBaseline = { score: 1.0, failureClusters: {} };
    const d = await promoteCandidate(CANDIDATE, failingSuite(), highBaseline, {
      requireStrictImprovement: true,
    });
    expect(d.promoted).toBe(false);
    expect(d.blockedBy).toBe("regression");
  });

  it("default mode still allows a tie (backward compatible)", async () => {
    const tieBaseline: EvalGateBaseline = { score: 1.0, failureClusters: {} };
    const d = await promoteCandidate(CANDIDATE, passingSuite(), tieBaseline);
    expect(d.promoted).toBe(true);
  });
});
