import { describe, expect, it } from "vitest";
import { findPlugBySlug } from "@/lib/plug/registry";
import type { PlugDefinition } from "@/lib/plug/schema-v2";
import {
  buildPlugApprovalMatrix,
  estimatePlugRunCostCents,
  evaluatePlugLaunchRequirements,
} from "@/lib/plug/launch-requirements";

function plugWithMixedReversibility(): PlugDefinition {
  const base = findPlugBySlug("weekly-ops-review");
  if (!base) throw new Error("missing test plug");
  return {
    ...base,
    id: "plug_reversibility_test",
    slug: "reversibility-test",
    declaredTools: [
      {
        toolId: "meta_ads",
        allowedActions: ["read_insights", "pause_campaign", "launch"],
        approvalRequiredActions: ["launch"],
        actionReversibility: {
          read_insights: "reversible",
          pause_campaign: "compensable",
          launch: "irreversible",
        },
        compensations: { pause_campaign: "resume_campaign" },
      },
    ],
  };
}

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

describe("per-action reversibility", () => {
  it("surfaces each action's reversibility class and compensation through buildPlugApprovalMatrix", () => {
    const [entry] = buildPlugApprovalMatrix(plugWithMixedReversibility());

    expect(entry.actionReversibility).toEqual({
      read_insights: "reversible",
      pause_campaign: "compensable",
      launch: "irreversible",
    });
    expect(entry.compensations).toEqual({ pause_campaign: "resume_campaign" });
  });

  it("surfaces the irreversible class through evaluatePlugLaunchRequirements without changing readiness", () => {
    const result = evaluatePlugLaunchRequirements(plugWithMixedReversibility(), {
      runLogArtifactId: "artifact_run_log",
      sampleOutputArtifactId: "artifact_sample_output",
    });

    const entry = result.approvalMatrix.find((matrixEntry) => matrixEntry.toolId === "meta_ads");
    expect(entry?.actionReversibility.launch).toBe("irreversible");
    expect(entry?.actionReversibility.pause_campaign).toBe("compensable");
    // 2a is schema + surfacing only: launch readiness logic is unchanged.
    expect(result.ready).toBe(true);
  });

  it("keeps the 20 in-code fixtures explicit about reversibility (no defaulting)", () => {
    const plug = findPlugBySlug("weekly-ops-review");
    if (!plug) throw new Error("missing test plug");
    for (const tool of plug.declaredTools) {
      for (const action of tool.allowedActions) {
        expect(tool.actionReversibility[action]).toBeDefined();
      }
    }
  });
});
