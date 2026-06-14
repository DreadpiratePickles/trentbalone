import { describe, expect, it, vi } from "vitest";
import type { WorkbenchSession } from "@/lib/types";
import type { WorkbenchProviderAdapter } from "@/lib/workbench-provider";
import {
  DEFAULT_SMOKE_STEPS,
  passingInteractionDriver,
  verifyInteractions,
  type AcceptanceStep,
  type InteractionDriver,
} from "./workbench-interaction-verify";
import { verifyBuild } from "./workbench-verify";

describe("verifyInteractions", () => {
  it("uses default smoke steps when none are provided", async () => {
    const driver = passingInteractionDriver();
    const result = await verifyInteractions({
      previewUrl: "http://localhost:3000",
      driver,
    });

    expect(result.passed).toBe(true);
    expect(result.transcript).toContain(DEFAULT_SMOKE_STEPS[0].action);
  });

  it("passes when a wired button changes state", async () => {
    const driver = wiredButtonDriver();
    const steps: AcceptanceStep[] = [
      { action: "click #add", expect: "list contains 'Buy milk'" },
    ];

    const result = await verifyInteractions({
      previewUrl: "http://localhost:3000",
      steps,
      driver,
    });

    expect(result.passed).toBe(true);
    expect(result.failures).toHaveLength(0);
    expect(result.transcript).toContain("clicked #add");
    expect(result.transcript).toContain("list contains 'Buy milk'");
  });

  it("fails with a specific message when a dead button does nothing", async () => {
    const driver = deadButtonDriver();
    const steps: AcceptanceStep[] = [
      { action: "click #add", expect: "list contains 'Buy milk'" },
    ];

    const result = await verifyInteractions({
      previewUrl: "http://localhost:3000",
      steps,
      driver,
    });

    expect(result.passed).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].detail).toContain("clicked #add");
    expect(result.failures[0].detail).toContain("list length stayed 0");
    expect(result.failures[0].detail).toContain("no network call fired");
    expect(result.detail).toContain("click #add");
  });

  it("calls driver.close on success", async () => {
    const close = vi.fn();
    const driver: InteractionDriver = {
      ...passingInteractionDriver(),
      close,
    };

    const result = await verifyInteractions({
      previewUrl: "http://localhost:3000",
      driver,
    });

    expect(result.passed).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("calls driver.close on failure", async () => {
    const close = vi.fn();
    const driver: InteractionDriver = {
      ...deadButtonDriver(),
      close,
    };

    const result = await verifyInteractions({
      previewUrl: "http://localhost:3000",
      steps: [{ action: "click #add", expect: "list contains 'Buy milk'" }],
      driver,
    });

    expect(result.passed).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes Playwright browser resources after successful interaction", async () => {
    const pageClose = vi.fn(async () => undefined);
    const browserClose = vi.fn(async () => undefined);
    const click = vi.fn(async () => undefined);
    const waitForTimeout = vi.fn(async () => undefined);
    const evaluate = vi.fn(async () => ({ bodyText: "Saved note Buy milk", elementCount: 4 }));

    vi.doMock("playwright", () => ({
      chromium: {
        launch: vi.fn(async () => ({
          newPage: vi.fn(async () => ({
            goto: vi.fn(async () => undefined),
            waitForLoadState: vi.fn(async () => undefined),
            waitForSelector: vi.fn(async () => undefined),
            locator: vi.fn(() => ({ first: () => ({ click }) })),
            waitForTimeout,
            evaluate,
            close: pageClose,
            on: vi.fn(),
          })),
          close: browserClose,
        })),
      },
    }));

    vi.resetModules();
    const { createPlaywrightInteractionDriver: createDriver, verifyInteractions: verify } =
      await import("./workbench-interaction-verify");

    const driver = createDriver("http://localhost:3000");
    await verify({
      previewUrl: "http://localhost:3000",
      steps: [{ action: "click first visible button", expect: "list contains 'Saved note'" }],
      driver,
    });

    expect(pageClose).toHaveBeenCalledTimes(1);
    expect(browserClose).toHaveBeenCalledTimes(1);
    vi.doUnmock("playwright");
    vi.resetModules();
  });
});

describe("verifyBuild interaction gate", () => {
  it("returns passed:false when interaction fails even though render checks pass (Potemkin case)", async () => {
    const provider = fakeProvider({});
    provider.inspectPreview = vi.fn(async (_session, url) => ({
      url,
      screenshot: { dataUri: "data:image/png;base64,AAAA", width: 1280, height: 720, storageKey: "provider.png" },
      domText: "Add task Buy milk",
      visibleElements: 5,
      consoleErrors: [],
      pageErrors: [],
    }));

    const verdict = await verifyBuild({
      session: session(),
      provider,
      interactionDriver: deadButtonDriver(),
      acceptanceSteps: [{ action: "click #add", expect: "list contains 'Buy milk'" }],
    });

    expect(verdict.checks.find((check) => check.name === "preview")?.status).toBe("pass");
    expect(verdict.checks.find((check) => check.name === "dom")?.status).toBe("pass");
    expect(verdict.checks.find((check) => check.name === "console")?.status).toBe("pass");
    expect(verdict.checks.find((check) => check.name === "renders")?.status).toBe("pass");
    expect(verdict.checks.find((check) => check.name === "interaction")?.status).toBe("fail");
    expect(verdict.checks.find((check) => check.name === "interaction")?.detail).toContain("no network call fired");
    expect(verdict.passed).toBe(false);
    expect(verdict.repairPrompt).toContain("interaction:");
    expect(verdict.repairPrompt).toContain("no network call fired");
  });
});

function wiredButtonDriver(): InteractionDriver {
  return {
    async performStep(step) {
      return {
        ok: true,
        detail: `clicked #add; list count increased from 0 to 1; satisfied: ${step.expect}`,
        consoleLogs: [],
        networkLogs: ["POST /api/todos 201"],
        visibleText: "Buy milk",
      };
    },
  };
}

function deadButtonDriver(): InteractionDriver {
  return {
    async performStep(step) {
      return {
        ok: false,
        detail: `clicked #add; list length stayed 0; no network call fired; expected: ${step.expect}`,
        consoleLogs: [],
        networkLogs: [],
        visibleText: "Add task",
      };
    },
  };
}

function session(): WorkbenchSession {
  return {
    id: "ws_1",
    companyId: "co_1",
    agentRole: "engineer",
    agentMode: "build",
    messageCount: 0,
    status: "running",
    provider: "mock_local",
    objective: "Build app",
    costCents: 0,
    createdAt: "2026-06-02T00:00:00.000Z",
    updatedAt: "2026-06-02T00:00:00.000Z",
    metadata: {
      networkPolicy: "allowlist",
      allowedHosts: [],
      maxRuntimeSeconds: 1800,
      maxCostCents: 250,
      approvalRequiredFor: ["deploy"],
      rollbackAvailable: true,
    },
  };
}

function fakeProvider(_opts: Record<string, unknown>): WorkbenchProviderAdapter {
  return {
    name: "fake",
    start: vi.fn(),
    stop: vi.fn(),
    exec: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0, durationMs: 1 })),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    listFiles: vi.fn(async () => [
      { name: "App.tsx", path: "src/App.tsx", isDir: false, sizeBytes: 1, modifiedAt: "2026-06-02T00:00:00.000Z" },
    ]),
    runTests: vi.fn(async () => ({ passed: 3, failed: 0, skipped: 0, durationMs: 1, output: "ok", exitCode: 0 })),
    screenshot: vi.fn(async () => ({
      dataUri: "data:image/png;base64,AAAA",
      width: 1280,
      height: 720,
      storageKey: "k",
    })),
    getPreviewUrl: vi.fn(async () => "http://localhost:3000"),
    captureArtifact: vi.fn(),
  } as WorkbenchProviderAdapter;
}
