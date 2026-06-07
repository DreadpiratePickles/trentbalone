import { describe, expect, it } from "vitest";
import { createRailsFeatureManifest, getRailsModule } from "./rails";

describe("app builder rails modules", () => {
  it("creates auth and payments rails steps with approval/cost metadata", () => {
    const auth = getRailsModule("auth", { provider: "authjs" });
    const payments = getRailsModule("payments", { provider: "stripe" });

    expect(auth.steps.map((step) => step.title)).toContain("Install Auth.js");
    expect(payments.requiresApproval).toBe(true);
    expect(payments.riskClass).toBe("costly");
  });

  it("keeps tests before implementation in feature manifests", () => {
    const manifest = createRailsFeatureManifest({
      feature: "payments",
      provider: "stripe",
      description: "Add subscription checkout",
    });

    expect(manifest.steps[0]).toMatchObject({ kind: "tests" });
    expect(manifest.steps.some((step) => step.kind === "payments")).toBe(true);
    expect(manifest.approvalRequiredFor).toContain("purchase");
  });
});
