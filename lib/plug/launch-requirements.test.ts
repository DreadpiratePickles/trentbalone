import { describe, expect, it } from "vitest";
import { findPlugBySlug } from "@/lib/plug/registry";
import {
  buildPlugApprovalMatrix,
  estimatePlugRunCostCents,
  evaluatePlugLaunchRequirements,
} from "@/lib/plug/launch-requirements";

describe("Plug launch requirements", () => {
  it("passes launch readiness only with fixtures, run logs, cost, approvals, and sample output", () => {
    const plug = findPlugBySlug("weekly-ops-review");
    if (!plug) throw new Error("missing test plug");

    const result = evaluatePlugLaunchRequirements(plug, {
      runLogArtifactId: "artifact_run_log",
      sampleOutputArtifactId: "artifact_sample_output",
    });

    expect(result.ready).toBe(true);
    expect(result.costEstimateCents).toBe(estimatePlugRunCostCents(plug));
    expect(result.approvalMatrix).toEqual(buildPlugApprovalMatrix(plug));
    expect(result.requirements.every((requirement) => requirement.status === "passed")).toBe(true);
  });

  it("fails closed when launch evidence is incomplete", () => {
    const plug = findPlugBySlug("weekly-ops-review");
    if (!plug) throw new Error("missing test plug");

    const result = evaluatePlugLaunchRequirements({
      ...plug,
      evalSet: { ...plug.evalSet, fixtureRefs: [] },
    }, {});

    expect(result.ready).toBe(false);
    expect(result.requirements.filter((requirement) => requirement.status === "failed").map((requirement) => requirement.id))
      .toEqual(["fixtures", "run_logs", "sample_output"]);
  });
});
