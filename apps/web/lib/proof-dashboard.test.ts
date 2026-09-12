import { describe, expect, it } from "vitest";
import { buildProofDashboard, parseProofArtifact } from "@/lib/proof-dashboard";

describe("proof dashboard", () => {
  it("parses proof artifacts without secrets and preserves partial provider state", () => {
    const proof = parseProofArtifact("artifacts/live-proofs/providers.json", JSON.stringify({
      generatedAt: "2026-06-14T00:00:00.000Z",
      summary: { total: 7, passed: 6, failed: 1, skipped: 0 },
      proofs: [
        { key: "stripe", status: "passed", evidence: { balanceBuckets: 2 } },
        { key: "x", status: "failed", error: "401 token invalid", token: "secret_should_not_escape" },
      ],
    }));

    expect(proof).toMatchObject({
      key: "providers",
      status: "partial",
      passed: 6,
      failed: 1,
    });
    expect(JSON.stringify(proof)).not.toContain("secret_should_not_escape");
  });

  it("marks missing required proof categories as not recorded", () => {
    const dashboard = buildProofDashboard({
      artifacts: [
        {
          path: "artifacts/live-proofs/epicA-daytona-soak20-2026-06-14.json",
          content: JSON.stringify({ passed: true, passCount: 20, failCount: 0, generatedAt: "2026-06-14T01:00:00.000Z" }),
        },
      ],
    });

    expect(dashboard.categories.find((category) => category.key === "workbench")?.status).toBe("passed");
    expect(dashboard.categories.map((category) => category.key)).toEqual(expect.arrayContaining([
      "run_button",
      "orchestration",
      "workbench",
      "providers",
      "mcp",
      "production",
    ]));
    expect(dashboard.categories.find((category) => category.key === "operating_cycle")?.status).toBe("not_recorded");
    expect(dashboard.summary.notRecorded).toBeGreaterThan(0);
  });

  it("recognizes run-button and orchestration truth proof artifacts", () => {
    const dashboard = buildProofDashboard({
      artifacts: [
        {
          path: "artifacts/live-proofs/run-button-truth-2026-06-16.json",
          content: JSON.stringify({ passed: true, generatedAt: "2026-06-16T01:00:00.000Z" }),
        },
        {
          path: "artifacts/live-proofs/orchestrator-truth-2026-06-17.json",
          content: JSON.stringify({ passed: true, generatedAt: "2026-06-16T01:02:00.000Z" }),
        },
      ],
    });

    expect(dashboard.categories.find((category) => category.key === "run_button")).toMatchObject({
      status: "passed",
      rerunCommand: "npm run orc:truth-proof",
    });
    expect(dashboard.categories.find((category) => category.key === "orchestration")).toMatchObject({
      status: "passed",
      rerunCommand: "npm run orc:truth-proof",
    });
  });
});
