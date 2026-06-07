import { describe, expect, it } from "vitest";
import { SEAT_MANIFESTS, buildOrchestratorSeatDossier } from "./seat-manifest";

describe("seat manifest contracts", () => {
  it("gives every seat explicit input/tool/output/handoff/budget/memory contracts", () => {
    for (const manifest of Object.values(SEAT_MANIFESTS)) {
      expect(manifest.inputContract.length).toBeGreaterThan(0);
      expect(manifest.toolContract.length).toBeGreaterThan(0);
      expect(manifest.outputContract.length).toBeGreaterThan(0);
      expect(manifest.successCriteria.length).toBeGreaterThan(0);
      expect(manifest.handoffContract.length).toBeGreaterThan(0);
      expect(manifest.budgetContract.length).toBeGreaterThan(0);
      expect(manifest.memoryContract.length).toBeGreaterThan(0);
    }
  });

  it("gives every seat tool Dify-style auth, schema, context, approval, execution, output, and audit metadata", () => {
    for (const manifest of Object.values(SEAT_MANIFESTS)) {
      for (const tool of manifest.tools) {
        expect(tool.description).toBeTruthy();
        expect(tool.authRequirement).toBeTruthy();
        expect(tool.parameterSchema.safeParse({ companyId: "co1", input: {} }).success).toBe(true);
        expect(tool.allowedContextKeys).toEqual(manifest.contextNeeds);
        expect(tool.reversibility).toBeTruthy();
        expect(typeof tool.approvalRequired).toBe("boolean");
        expect(tool.executionMode).toBeTruthy();
        expect(tool.outputSchema.safeParse({ status: "completed", summary: "ok" }).success).toBe(true);
        expect(tool.audit.category).toBe(tool.executionMode);
      }
    }
  });

  it("builds a serializable CEO dossier without leaking zod internals", () => {
    const dossier = buildOrchestratorSeatDossier();
    const serialized = JSON.stringify(dossier);
    expect(serialized).toContain("CEO routes");
    expect(serialized).not.toContain("_def");
  });

  it("gives every content/social/ads mission seat the shared contentMission context key", () => {
    for (const role of ["ceo", "growth", "content", "support", "finance", "analyst", "escalation", "sales"] as const) {
      expect(SEAT_MANIFESTS[role].contextNeeds).toContain("contentMission");
    }
  });
});
