import { describe, expect, it, vi } from "vitest";
import type { WorkbenchSession } from "@/lib/types";
import { DIVERSE_PROMPT_CASES } from "@/lib/workbench-live-cloud-diverse-scaffolds";
import { runCloudWorkbenchDiverseProof } from "@/lib/workbench-live-cloud-diverse";

vi.mock("@/lib/workbench-live-cloud-eval", () => ({
  runCloudWorkbenchBuildProof: vi.fn(async (input: { scaffoldFiles?: Record<string, string> }) => ({
    passed: Boolean(input.scaffoldFiles?.["package.json"]),
    provider: "daytona",
    sessionId: "workbench_test",
    previewUrl: "https://preview.example",
    httpStatus: 200,
    domText: "proof",
    visibleElements: 4,
    screenshotStorageKey: "daytona/workbench_test/screenshot",
    commandResults: [
      { command: "npm install", exitCode: 0, durationMs: 1, stdout: "", stderr: "" },
      { command: "npm run typecheck", exitCode: 0, durationMs: 1, stdout: "", stderr: "" },
      { command: "npm run build", exitCode: 0, durationMs: 1, stdout: "", stderr: "" },
      { command: "npm test", exitCode: 0, durationMs: 1, stdout: "", stderr: "" },
    ],
    testResult: { passed: 1, failed: 0, skipped: 0, exitCode: 0 },
    artifacts: [],
    failures: [],
    warnings: [],
    degradedArtifacts: false,
    interactionPassed: true,
    interactionTranscript: "PASS",
    inspectDiagnostics: { proxyAuthUsed: true, domProbeSource: "browser" },
  })),
}));

describe("DIVERSE_PROMPT_CASES", () => {
  it("defines five prompt classes with scaffolds and interaction steps", () => {
    expect(DIVERSE_PROMPT_CASES.map((entry) => entry.id)).toEqual([
      "static-landing",
      "nextjs-app",
      "api-db",
      "dashboard-chart",
      "persistent-form",
    ]);
    for (const entry of DIVERSE_PROMPT_CASES) {
      expect(entry.scaffoldFiles["package.json"]).toBeTruthy();
      expect(entry.expectedTexts.length).toBeGreaterThan(0);
      expect(entry.interactionSteps.length).toBeGreaterThan(0);
    }
  });

  it("uses lighter Next.js build settings for Daytona memory limits", () => {
    const nextCase = DIVERSE_PROMPT_CASES.find((entry) => entry.id === "nextjs-app");
    expect(nextCase?.buildEnv.NEXT_TELEMETRY_DISABLED).toBe("1");
    expect(nextCase?.scaffoldFiles["next.config.mjs"]).toContain("ignoreDuringBuilds");
  });
});

describe("runCloudWorkbenchDiverseProof", () => {
  it("runs all prompt classes and reports pass rate", async () => {
    let sessionCount = 0;
    const result = await runCloudWorkbenchDiverseProof({
      threshold: 1,
      createSession: async (prompt) => {
        sessionCount += 1;
        return {
          id: `workbench_${prompt.id}`,
          companyId: "company_1",
          agentRole: "engineer",
          status: "queued",
          provider: "daytona",
          objective: prompt.objective,
          costCents: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          metadata: { networkPolicy: "allowlist", allowedHosts: [], maxRuntimeSeconds: 3600, maxCostCents: 1000, approvalRequiredFor: [], rollbackAvailable: false },
        } satisfies WorkbenchSession;
      },
      getProvider: () => ({ name: "daytona" }) as never,
    });

    expect(sessionCount).toBe(5);
    expect(result.passCount).toBe(5);
    expect(result.passed).toBe(true);
    expect(result.prompts).toHaveLength(5);
  });
});
