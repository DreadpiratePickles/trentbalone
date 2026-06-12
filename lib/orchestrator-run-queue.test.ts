import { describe, expect, it } from "vitest";
import { cascadeFailedDependencySteps } from "@/lib/orchestrator-run-queue";
import type { StepRecord } from "@/lib/orchestrator-runtime";

function step(input: Partial<StepRecord> & Pick<StepRecord, "id" | "status" | "dependsOn">): StepRecord {
  return {
    title: input.id,
    rationale: "test",
    agentRole: "engineer",
    expectedOutput: "output",
    riskLevel: "low",
    needsApproval: false,
    ...input,
  } as StepRecord;
}

describe("cascadeFailedDependencySteps", () => {
  it("marks pending dependents failed recursively so orchestration can consolidate", () => {
    const steps = [
      step({ id: "s1", status: "failed", dependsOn: [], title: "Analyze sources" }),
      step({ id: "s2", status: "pending", dependsOn: ["s1"], title: "Draft plan" }),
      step({ id: "s3", status: "pending", dependsOn: ["s2"], title: "Consolidate" }),
    ];

    const cascaded = cascadeFailedDependencySteps(steps, "2026-06-11T23:20:00.000Z");

    expect(cascaded.map((item) => item.id)).toEqual(["s2", "s3"]);
    expect(steps.map((item) => item.status)).toEqual(["failed", "failed", "failed"]);
    expect(steps[1].output).toContain("dependency \"Analyze sources\" failed");
    expect(steps[2].output).toContain("dependency \"Draft plan\" failed");
    expect(steps[2].completedAt).toBe("2026-06-11T23:20:00.000Z");
  });

  it("does not cascade degraded usable failed dependencies", () => {
    const steps = [
      step({ id: "s1", status: "failed", dependsOn: [], title: "Analyze sources", output: "DEGRADED: analytics source unavailable; completed using operating brief and roadmap evidence." }),
      step({ id: "s2", status: "pending", dependsOn: ["s1"], title: "Consolidate" }),
    ];

    const cascaded = cascadeFailedDependencySteps(steps, "2026-06-11T23:20:00.000Z");

    expect(cascaded).toEqual([]);
    expect(steps.map((item) => item.status)).toEqual(["failed", "pending"]);
  });

  it("does not cascade blocked tool-denial steps that still produced usable guidance", () => {
    const steps = [
      step({
        id: "s1",
        status: "blocked",
        dependsOn: [],
        title: "Execute audit tool",
        output: "The escalation seat is not permitted to create an audit using the audit:create tool. Route the audit creation task to a permitted seat.",
      }),
      step({ id: "s2", status: "pending", dependsOn: ["s1"], title: "Consolidate" }),
    ];

    const cascaded = cascadeFailedDependencySteps(steps, "2026-06-11T23:20:00.000Z");

    expect(cascaded).toEqual([]);
    expect(steps.map((item) => item.status)).toEqual(["blocked", "pending"]);
  });
});
