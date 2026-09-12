import { describe, it, expect } from "vitest";
import {
  buildCompletedStepOutputs,
  collectReadyOrchestrationSteps,
} from "@/lib/orchestrator";
import type { StepRecord } from "@/lib/orchestrator-runtime";

/**
 * Regression: a dependency that COMPLETES WITH EMPTY OUTPUT must still satisfy
 * its dependents. Previously readiness was gated on a truthy output, so an
 * empty-output completed step stranded its dependents in "pending" forever and
 * the whole run never reached consolidation (silent hang).
 */
function step(partial: Partial<StepRecord> & Pick<StepRecord, "id" | "status">): StepRecord {
  return {
    title: partial.id,
    rationale: "",
    agentRole: "engineer",
    dependsOn: [],
    expectedOutput: "",
    riskLevel: "low",
    needsApproval: false,
    output: undefined,
    ...partial,
  } as StepRecord;
}

describe("orchestrator readiness — empty-output dependency", () => {
  it("treats a completed step with empty output as a satisfied dependency", () => {
    const steps: StepRecord[] = [
      step({ id: "s1", status: "completed", output: "" }),
      step({ id: "s2", status: "completed", output: undefined }),
    ];
    const outputs = buildCompletedStepOutputs(steps);
    expect("s1" in outputs).toBe(true);
    expect("s2" in outputs).toBe(true);
    expect(outputs.s1).toBe("");
    expect(outputs.s2).toBe("");
  });

  it("marks a dependent READY when its dependency completed with empty output", () => {
    const steps: StepRecord[] = [
      step({ id: "s1", status: "completed", output: "" }),
      step({ id: "s2", status: "pending", dependsOn: ["s1"] }),
    ];
    const ready = collectReadyOrchestrationSteps(steps);
    expect(ready.map((s) => s.id)).toContain("s2");
  });

  it("still withholds a dependent whose dependency has not completed", () => {
    const steps: StepRecord[] = [
      step({ id: "s1", status: "running" }),
      step({ id: "s2", status: "pending", dependsOn: ["s1"] }),
    ];
    const ready = collectReadyOrchestrationSteps(steps);
    expect(ready.map((s) => s.id)).not.toContain("s2");
  });
});
