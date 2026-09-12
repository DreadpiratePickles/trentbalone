import { describe, expect, it } from "vitest";
import { buildOrchestratorPreflightSnapshot } from "@/lib/orchestrator-preflight";

describe("orchestrator preflight snapshot", () => {
  it("captures autonomy, provider readiness, connector readiness, memory, budget, and approval policy", () => {
    const snapshot = buildOrchestratorPreflightSnapshot({
      company: {
        id: "co_1",
        autonomyLevel: "autonomous_within_limits",
        weeklyBudgetCents: 5_000,
        budgetCents: 1_000,
        brief: {
          vision: "Preflight",
          icp: "Founders",
          offer: "Agent ops",
          pricing: "$99/mo",
          competitors: "a competing platform, a competing product",
          brandVoice: "direct",
          goals: "ship safely",
          constraints: "no fake claims",
          successMetrics: "proofs pass",
          autonomy: {
            mode: "autonomous",
            reversibleToolsAllowed: true,
            approvalRequiredForExternalWrites: true,
            approvalRequiredForSpend: true,
            dailySpendLimitCents: 250,
            maxAutonomousToolCallsPerRun: 4,
            allowlistedToolScopes: ["engineer:workbench:exec"],
            blockedToolScopes: ["social:publish"],
            updatedAt: "2026-06-16T10:00:00.000Z",
          },
        },
      },
      env: {
        GITHUB_TOKEN: "ghp_test",
        DAYTONA_API_KEY: "daytona",
        DATABASE_URL: "postgres://test",
      },
      memorySourceCounts: {
        documents: 3,
        episodic: 2,
        semantic: 1,
        workbenchArtifacts: 4,
      },
      mcpServerCount: 1,
    });

    expect(snapshot.autonomy.mode).toBe("autonomous");
    expect(snapshot.budget.weeklyBudgetCents).toBe(5_000);
    expect(snapshot.approvalPolicy.externalWrites).toBe("approval_required");
    expect(snapshot.approvalPolicy.spend).toBe("approval_required");
    expect(snapshot.memory.totalSources).toBe(10);
    expect(snapshot.providers.some((provider) => provider.key === "sandbox" && provider.status === "real")).toBe(true);
    expect(snapshot.connectors.rows.some((row) => row.key === "github" && row.status === "connected")).toBe(true);
    expect(snapshot.toolReadiness.connected).toBeGreaterThan(0);
    expect(snapshot.generatedAt).toEqual(expect.any(String));
  });
});
