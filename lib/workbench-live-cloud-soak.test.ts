import { describe, expect, it, vi } from "vitest";
import type { WorkbenchSession } from "@/lib/types";
import type { WorkbenchProviderAdapter } from "@/lib/workbench-provider";
import { runCloudWorkbenchSoak } from "@/lib/workbench-live-cloud-soak";

describe("runCloudWorkbenchSoak", () => {
  it("runs the same Workbench proof repeatedly and reports pass rate, screenshots, and failure clusters", async () => {
    const proofs = [
      proof({ sessionId: "ws_1", passed: true, screenshotStorageKey: "screens/ws_1.png" }),
      proof({ sessionId: "ws_2", passed: true, screenshotStorageKey: "screens/ws_2.png" }),
      proof({ sessionId: "ws_3", passed: false, failures: ["preview DOM is blank", "console errors: boom"] }),
      proof({ sessionId: "ws_4", passed: false, failures: ["preview DOM is blank"] }),
    ];
    const runProof = vi.fn(async () => proofs.shift()!);

    const result = await runCloudWorkbenchSoak({
      runs: 4,
      threshold: 0.5,
      createSession: async (runIndex) => session(`ws_${runIndex}`),
      getProvider: () => provider(),
      runProof,
    });

    expect(runProof).toHaveBeenCalledTimes(4);
    expect(result.passed).toBe(true);
    expect(result.passCount).toBe(2);
    expect(result.failCount).toBe(2);
    expect(result.passRate).toBeCloseTo(0.5);
    expect(result.screenshotStorageKeys).toEqual(["screens/ws_1.png", "screens/ws_2.png"]);
    expect(result.failureClusters).toEqual([
      { message: "preview DOM is blank", count: 2 },
      { message: "console errors: boom", count: 1 },
    ]);
    expect(result.results.map((item) => item.runIndex)).toEqual([1, 2, 3, 4]);
  });

  it("counts build-passed runs with degraded artifact durability without failing them", async () => {
    const proofs = [
      proof({ sessionId: "ws_1", passed: true, screenshotStorageKey: "screens/ws_1.png" }),
      proof({
        sessionId: "ws_2",
        passed: true,
        screenshotStorageKey: "screens/ws_2.png",
        warnings: ["Timed out daytona snapshot after 180000ms"],
      }),
    ];
    const runProof = vi.fn(async () => proofs.shift()!);

    const result = await runCloudWorkbenchSoak({
      runs: 2,
      threshold: 0.9,
      createSession: async (runIndex) => session(`ws_${runIndex}`),
      getProvider: () => provider(),
      runProof,
    });

    // The degraded run still built and served — it must NOT drag the pass rate down.
    expect(result.passed).toBe(true);
    expect(result.passCount).toBe(2);
    expect(result.failCount).toBe(0);
    expect(result.degradedRunCount).toBe(1);
    expect(result.results[1].degradedArtifacts).toBe(true);
  });
});

function proof(input: {
  sessionId: string;
  passed: boolean;
  screenshotStorageKey?: string;
  failures?: string[];
  warnings?: string[];
}) {
  const warnings = input.warnings ?? [];
  return {
    passed: input.passed,
    provider: "daytona",
    sessionId: input.sessionId,
    previewUrl: `https://preview.example/${input.sessionId}`,
    httpStatus: input.passed ? 200 : 500,
    domText: input.passed ? "Cloud Notes" : "",
    visibleElements: input.passed ? 4 : 0,
    screenshotStorageKey: input.screenshotStorageKey,
    commandResults: [],
    artifacts: [],
    failures: input.failures ?? [],
    warnings,
    degradedArtifacts: warnings.length > 0,
  };
}

function session(id: string): WorkbenchSession {
  return {
    id,
    companyId: "co_1",
    agentRole: "engineer",
    agentMode: "build",
    status: "queued",
    provider: "daytona",
    objective: "Build and verify a cloud notes app",
    costCents: 0,
    createdAt: "2026-06-12T00:00:00.000Z",
    updatedAt: "2026-06-12T00:00:00.000Z",
    metadata: {
      networkPolicy: "allowlist",
      allowedHosts: ["registry.npmjs.org"],
      maxRuntimeSeconds: 1800,
      maxCostCents: 250,
      approvalRequiredFor: [],
      rollbackAvailable: true,
    },
  };
}

function provider(): WorkbenchProviderAdapter {
  return {
    name: "daytona",
    start: vi.fn(),
    restore: vi.fn(),
    stop: vi.fn(),
    exec: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    listFiles: vi.fn(),
    runTests: vi.fn(),
    screenshot: vi.fn(),
    getPreviewUrl: vi.fn(),
    getFileTree: vi.fn(),
    diffSinceCheckpoint: vi.fn(),
    captureArtifact: vi.fn(),
  };
}
