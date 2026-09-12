import { describe, it, expect } from "vitest";
import {
  computeSkillHealth,
  isSkillDegraded,
  describeDegradation,
  scanDegradedSkills,
  DEFAULT_SKILL_HEALTH_THRESHOLDS,
  type SkillHealth,
} from "@/lib/skill-health";
import type { TraceRecord } from "@/lib/trace-store";

function trace(overrides: Partial<TraceRecord> = {}): TraceRecord {
  return {
    id: "t",
    companyId: "c1",
    runId: "r1",
    taskType: "churn_analysis",
    agentRole: "analyst",
    stepTitle: "step",
    status: "completed",
    toolCalls: [],
    toolCallCount: 0,
    costCents: 1,
    humanCorrected: false,
    createdAt: "2026-06-02T00:00:00.000Z",
    critiqueVerdict: "pass",
    ...overrides,
  };
}

describe("computeSkillHealth", () => {
  it("returns all-zero health for an empty trace set", () => {
    const h = computeSkillHealth("churn_analysis", []);
    expect(h.sampleSize).toBe(0);
    expect(h.completionRate).toBe(0);
  });

  it("computes completion, fallback, failure, correction, and applied rates", () => {
    const traces = [
      trace({ status: "completed", critiqueVerdict: "pass", skillApplied: true }),
      trace({ status: "completed", critiqueVerdict: "retry" }),
      trace({ status: "failed", critiqueVerdict: "escalate", humanCorrected: true }),
      trace({ status: "completed", critiqueVerdict: "pass", skillApplied: true }),
    ];
    const h = computeSkillHealth("churn_analysis", traces);
    expect(h.sampleSize).toBe(4);
    expect(h.completionRate).toBeCloseTo(2 / 4);
    expect(h.fallbackRate).toBeCloseTo(2 / 4); // retry + escalate
    expect(h.failureRate).toBeCloseTo(1 / 4);
    expect(h.humanCorrectionRate).toBeCloseTo(1 / 4);
    expect(h.appliedRate).toBeCloseTo(2 / 4);
  });

  it("treats missing skillApplied as not-applied (conservative)", () => {
    const h = computeSkillHealth("x", [trace(), trace()]);
    expect(h.appliedRate).toBe(0);
  });
});

describe("applied-rate degradation", () => {
  it("is ignored when minAppliedRate is 0 (default)", () => {
    const h = computeSkillHealth("x", [trace(), trace(), trace()]); // appliedRate 0
    expect(isSkillDegraded(h)).toBe(false);
  });

  it("flags a healthy-but-bypassed skill when minAppliedRate is enabled", () => {
    const traces = [trace(), trace(), trace()]; // all pass, none applied
    const h = computeSkillHealth("x", traces);
    const thresholds = { ...DEFAULT_SKILL_HEALTH_THRESHOLDS, minAppliedRate: 0.5 };
    expect(isSkillDegraded(h, thresholds)).toBe(true);
    expect(describeDegradation(h, thresholds).join(" ")).toContain("bypassed");
  });
});

describe("isSkillDegraded", () => {
  it("never flags below the minimum sample size", () => {
    const h: SkillHealth = {
      taskType: "x",
      sampleSize: 2,
      completionRate: 0,
      fallbackRate: 1,
      failureRate: 1,
      humanCorrectionRate: 1,
      appliedRate: 0,
    };
    expect(isSkillDegraded(h)).toBe(false);
  });

  it("flags a low completion rate with enough samples", () => {
    const traces = [
      trace({ critiqueVerdict: "retry", status: "completed" }),
      trace({ critiqueVerdict: "retry", status: "completed" }),
      trace({ critiqueVerdict: "pass", status: "completed" }),
    ];
    const h = computeSkillHealth("x", traces);
    // completion 1/3 ≈ 0.33 < 0.6 → degraded
    expect(isSkillDegraded(h)).toBe(true);
    expect(describeDegradation(h).join(" ")).toContain("completion");
  });

  it("does not flag a healthy skill", () => {
    const traces = [trace(), trace(), trace(), trace()];
    const h = computeSkillHealth("x", traces);
    expect(isSkillDegraded(h)).toBe(false);
    expect(describeDegradation(h)).toHaveLength(0);
  });
});

describe("scanDegradedSkills", () => {
  it("only scans task types that have a live skill, worst-first", () => {
    const healthy = [trace(), trace(), trace()];
    const rotten = [
      trace({ taskType: "rotten", status: "failed", critiqueVerdict: "escalate" }),
      trace({ taskType: "rotten", status: "failed", critiqueVerdict: "escalate" }),
      trace({ taskType: "rotten", status: "completed", critiqueVerdict: "pass" }),
    ];
    const byType = new Map<string, readonly TraceRecord[]>([
      ["healthy", healthy],
      ["rotten", rotten],
      ["no_skill", rotten], // degraded but no live skill → ignored
    ]);
    const degraded = scanDegradedSkills(byType, ["healthy", "rotten"]);
    expect(degraded.map((d) => d.taskType)).toEqual(["rotten"]);
  });

  it("respects custom thresholds", () => {
    const traces = [trace(), trace(), trace()];
    const byType = new Map<string, readonly TraceRecord[]>([["x", traces]]);
    // Impossible completion bar → always degraded
    const degraded = scanDegradedSkills(byType, ["x"], {
      ...DEFAULT_SKILL_HEALTH_THRESHOLDS,
      minCompletionRate: 1.1,
    });
    expect(degraded).toHaveLength(1);
  });
});
