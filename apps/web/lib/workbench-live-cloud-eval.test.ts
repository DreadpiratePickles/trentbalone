import { describe, expect, it, vi } from "vitest";
import type { WorkbenchSession } from "@/lib/types";
import type {
  WorkbenchProviderAdapter,
  WorkbenchScreenshotResult,
} from "@/lib/workbench-provider";
import { runCloudWorkbenchBuildProof } from "@/lib/workbench-live-cloud-eval";
import {
  passingInteractionDriver,
  type InteractionDriver,
} from "@/lib/workbench-interaction-verify";

const passingDriverFactory = () => passingInteractionDriver();

describe("runCloudWorkbenchBuildProof", () => {
  it("scaffolds, installs, verifies, previews, inspects, exports, and stops the cloud sandbox", async () => {
    const calls: string[] = [];
    const progress: string[] = [];
    const provider = fakeProvider(calls);

    const result = await runCloudWorkbenchBuildProof({
      session: session(),
      provider,
      previewPort: 3000,
      interactionDriverFactory: passingDriverFactory,
      onProgress: (event) => progress.push(`${event.stage}:${event.status}`),
    });

    expect(result.passed).toBe(true);
    expect(result.interactionPassed).toBe(true);
    expect(result.provider).toBe("daytona");
    expect(result.previewUrl).toBe("https://preview.example");
    expect(result.httpStatus).toBe(200);
    expect(result.visibleElements).toBeGreaterThan(0);
    expect(result.domText).toContain("Cloud Notes");
    expect(result.screenshotStorageKey).toBe("proof/screenshot.png");
    expect(result.commandResults.map((entry) => entry.command)).toEqual([
      "npm install",
      "npm run typecheck",
      "npm run build",
      "npm test",
    ]);
    expect(result.artifacts).toEqual(expect.arrayContaining([
      "snapshot:snapshot_1",
      "export:artifact_1",
    ]));
    expect(calls).toEqual(expect.arrayContaining([
      "start",
      "write:package.json",
      "write:src/App.tsx",
      "exec:npm install",
      "exec:npm run typecheck",
      "exec:npm run build",
      "tests:npm test",
      "preview:npm run dev -- --host 0.0.0.0:3000",
      "inspect:https://preview.example",
      "snapshot",
      "export",
      "stop",
    ]));
    expect(calls.indexOf("start")).toBeLessThan(calls.indexOf("write:package.json"));
    expect(calls.at(-1)).toBe("stop");
    expect(progress).toEqual([
      "start:running",
      "start:completed",
      "scaffold:running",
      "scaffold:completed",
      "command:running",
      "command:completed",
      "command:running",
      "command:completed",
      "command:running",
      "command:completed",
      "test:running",
      "test:completed",
      "preview:running",
      "preview:completed",
      "inspect:running",
      "inspect:completed",
      "interaction:running",
      "interaction:completed",
      "snapshot:running",
      "snapshot:completed",
      "export:running",
      "export:completed",
      "stop:running",
      "stop:completed",
    ]);
  });

  it("fails safely and still stops the sandbox when verification fails", async () => {
    const calls: string[] = [];
    const provider = fakeProvider(calls, {
      inspection: {
        url: "https://preview.example",
        httpStatus: 200,
        screenshot: screenshot(),
        domText: "",
        visibleElements: 0,
        consoleErrors: [],
        pageErrors: [],
      },
    });

    const result = await runCloudWorkbenchBuildProof({
      session: session(),
      provider,
      previewPort: 3000,
    });

    expect(result.passed).toBe(false);
    expect(result.failures).toContain("preview DOM is blank");
    expect(calls.at(-1)).toBe("stop");
  });

  it("fails with a bounded startup timeout when the cloud provider hangs", async () => {
    const calls: string[] = [];
    const provider = fakeProvider(calls, {
      start: vi.fn(async () => {
        calls.push("start");
        return new Promise<never>(() => undefined);
      }),
    });

    const result = await runCloudWorkbenchBuildProof({
      session: session(),
      provider,
      previewPort: 3000,
      startTimeoutMs: 5,
    });

    expect(result.passed).toBe(false);
    expect(result.failures.join("\n")).toContain("Timed out starting daytona sandbox");
    expect(calls).toEqual(["start", "stop"]);
  });

  it("treats slow snapshot/export as non-fatal degraded artifacts and still stops the sandbox", async () => {
    const calls: string[] = [];
    const provider = fakeProvider(calls, {
      snapshot: vi.fn(async () => {
        calls.push("snapshot");
        return new Promise<never>(() => undefined);
      }),
      exportArtifacts: vi.fn(async () => {
        calls.push("export");
        return new Promise<never>(() => undefined);
      }),
    });

    const result = await runCloudWorkbenchBuildProof({
      session: session(),
      provider,
      previewPort: 3000,
      providerOperationTimeoutMs: 5,
      artifactOperationAttempts: 1,
      interactionDriverFactory: passingDriverFactory,
    });

    // Snapshot/export are artifact-durability operations, not build correctness.
    // A timeout there must NOT fail an otherwise-green build (the run-13 soak pattern).
    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.degradedArtifacts).toBe(true);
    expect(result.warnings).toEqual(expect.arrayContaining([
      "Timed out daytona snapshot after 5ms",
      "Timed out daytona export after 5ms",
    ]));
    expect(calls.at(-1)).toBe("stop");
  });

  it("fails the build when the preview renders but does not respond to interaction (Potemkin UI)", async () => {
    const calls: string[] = [];
    const provider = fakeProvider(calls);
    const deadDriver: InteractionDriver = {
      async performStep(step) {
        return {
          ok: false,
          detail: `${step.action}; list length stayed 0; no network call fired; page did not respond`,
          consoleLogs: [],
          networkLogs: [],
        };
      },
    };

    const result = await runCloudWorkbenchBuildProof({
      session: session(),
      provider,
      previewPort: 3000,
      interactionDriverFactory: () => deadDriver,
    });

    expect(result.interactionPassed).toBe(false);
    expect(result.passed).toBe(false);
    expect(result.failures.join("\n")).toContain("interaction failed");
    expect(calls.at(-1)).toBe("stop");
  });
});

function fakeProvider(
  calls: string[],
  overrides: Partial<WorkbenchProviderAdapter> & {
    inspection?: Awaited<ReturnType<NonNullable<WorkbenchProviderAdapter["inspectPreview"]>>>;
  } = {},
): WorkbenchProviderAdapter {
  return {
    name: "daytona",
    start: vi.fn(async () => {
      calls.push("start");
      return {
        provider: "daytona" as const,
        providerSessionId: "sandbox_1",
        workdir: "/workspaces/co_1/proof",
        previewMode: "provider_url" as const,
        expiresAt: "2026-06-05T01:00:00.000Z",
      };
    }),
    restore: vi.fn(),
    stop: vi.fn(async () => {
      calls.push("stop");
    }),
    exec: vi.fn(async (_session, command) => {
      calls.push(`exec:${command}`);
      return { stdout: "ok", stderr: "", exitCode: 0, durationMs: 1 };
    }),
    readFile: vi.fn(async () => ""),
    writeFile: vi.fn(async (_session, path) => {
      calls.push(`write:${path}`);
    }),
    listFiles: vi.fn(async () => []),
    runTests: vi.fn(async (_session, command) => {
      calls.push(`tests:${command}`);
      return { passed: 1, failed: 0, skipped: 0, durationMs: 1, output: "1 passed", exitCode: 0 };
    }),
    screenshot: vi.fn(async () => screenshot()),
    getPreviewUrl: vi.fn(async () => "https://preview.example"),
    startPreview: vi.fn(async (_session, command, port) => {
      calls.push(`preview:${command}:${port}`);
      return {
        command,
        port,
        url: "https://preview.example",
        result: { stdout: "started", stderr: "", exitCode: 0, durationMs: 1 },
      };
    }),
    getFileTree: vi.fn(async () => []),
    diffSinceCheckpoint: vi.fn(),
    snapshot: vi.fn(async () => {
      calls.push("snapshot");
      return { id: "snapshot_1", fileTreeHash: "hash_1", createdAt: "2026-06-05T00:00:00.000Z" };
    }),
    exportArtifacts: vi.fn(async () => {
      calls.push("export");
      return {
        artifact: {
          id: "artifact_1",
          companyId: "co_1",
          sessionId: "ws_1",
          kind: "export" as const,
          title: "export",
          storageKey: "export.md",
          mimeType: "text/markdown",
          sizeBytes: 1,
          createdAt: "2026-06-05T00:00:00.000Z",
        },
        event: {
          id: "event_1",
          companyId: "co_1",
          sessionId: "ws_1",
          type: "artifact" as const,
          status: "completed" as const,
          title: "export",
          content: "export",
          createdAt: "2026-06-05T00:00:00.000Z",
        },
      };
    }),
    inspectPreview: vi.fn(async (_session, url) => {
      calls.push(`inspect:${url}`);
      return overrides.inspection ?? {
        url,
        httpStatus: 200,
        screenshot: screenshot(),
        domText: "Cloud Notes Save note",
        visibleElements: 4,
        consoleErrors: [],
        pageErrors: [],
      };
    }),
    captureArtifact: vi.fn(),
    ...overrides,
  };
}

function screenshot(): WorkbenchScreenshotResult {
  return {
    dataUri: "data:image/png;base64,cmVhbC1wbmc=",
    width: 1280,
    height: 720,
    storageKey: "proof/screenshot.png",
  };
}

function session(): WorkbenchSession {
  return {
    id: "ws_1",
    companyId: "co_1",
    agentRole: "engineer",
    agentMode: "build",
    status: "running",
    provider: "daytona",
    objective: "Build and verify a cloud notes app",
    costCents: 0,
    createdAt: "2026-06-05T00:00:00.000Z",
    updatedAt: "2026-06-05T00:00:00.000Z",
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
