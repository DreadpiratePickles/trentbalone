import { describe, expect, it } from "vitest";
import { plugSchemaV2, toolActionAllowed, plugMemoryNamespace } from "@/lib/plug/schema-v2";

describe("Plug schema v2", () => {
  it("validates full workflow templates with measured marketplace fields", () => {
    const plug = plugSchemaV2.parse({
      id: "plug_weekly_ops",
      slug: "weekly-ops-review",
      name: "Weekly Ops Review",
      category: "operations",
      industry: "b2b-saas",
      complexityTier: "standard",
      version: "1.0.0",
      declaredTools: [{ toolId: "reports", allowedActions: ["create"], approvalRequiredActions: [] }],
      integrations: ["analytics"],
      seats: [{ seat: "analyst", promptTemplate: "Review {{company}}", outputContract: "weekly_report.v1", timeoutMs: 600000, budgetCents: 200, modelTier: "sonnet" }],
      memoryNamespace: "company:{companyId}/plug:weekly-ops-review",
      cycles: [{ cadence: "weekly", cron: "0 9 * * 1" }],
      evalSet: { fixtureRefs: ["fixture_1"], passThreshold: 0.8, lastScore: 0.91 },
      capabilityScore: 0.91,
      costPerRunCents: 125,
      completionRate: 0.96,
      pricing: { mode: "free", revenueShareBps: 0 },
      publisher: { id: "trent", verified: true, ownershipHistory: [{ publisherId: "trent", changedAt: "2026-05-29T00:00:00.000Z", reviewed: true }] },
      changelog: [{ version: "1.0.0", notes: "Initial", createdAt: "2026-05-29T00:00:00.000Z" }],
      visibility: { scope: "public" },
    });

    expect(toolActionAllowed(plug, "reports", "create")).toBe(true);
    expect(toolActionAllowed(plug, "reports", "delete")).toBe(false);
    expect(plugMemoryNamespace(plug, "co_1")).toBe("company:co_1/plug:weekly-ops-review");
  });
});
