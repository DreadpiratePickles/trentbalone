import { describe, expect, it } from "vitest";
import { createAppBuilderManifest, estimateAppBuildCost, normalizeAppBuilderPrompt } from "./manifest";

describe("app builder manifest", () => {
  it("normalizes prompt and rejects blank input", () => {
    expect(normalizeAppBuilderPrompt("  Build a CRM  ")).toBe("Build a CRM");
    expect(() => normalizeAppBuilderPrompt(" ")).toThrow("prompt is required");
  });

  it("creates a test-first full-stack manifest with approval gates and rollback metadata", () => {
    const manifest = createAppBuilderManifest({
      companyId: "co_1",
      prompt: "Build a SaaS app with auth, billing, dashboard, and deploy",
      framework: "nextjs",
    });

    expect(manifest.framework).toBe("nextjs");
    expect(manifest.features).toEqual(["repo", "database", "auth", "payments", "deploy", "tests", "preview"]);
    expect(manifest.testFirst).toBe(true);
    expect(manifest.rollbackAvailable).toBe(true);
    expect(manifest.approvalRequiredFor).toEqual(expect.arrayContaining([
      "pull_request_create",
      "deploy",
      "public_url_expose",
      "purchase",
    ]));
    expect(manifest.steps[0]).toMatchObject({ kind: "tests", requiresApproval: false });
    expect(manifest.steps.some((step) => step.kind === "deploy" && step.requiresApproval)).toBe(true);
    expect(manifest.estimatedCostCents).toBeGreaterThan(0);
  });

  it("adds feature-specific costs without charging for the manifest itself", () => {
    expect(estimateAppBuildCost(["repo", "database", "auth", "payments", "deploy", "tests", "preview"])).toBe(1_850);
  });
});
