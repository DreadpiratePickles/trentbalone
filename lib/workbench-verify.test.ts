import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkbenchSession } from "@/lib/types";
import type {
  WorkbenchProviderAdapter,
  WorkbenchTestResult,
  WorkbenchExecResult,
  WorkbenchScreenshotResult,
} from "@/lib/workbench-provider";
import { verifyBuild, verifyWithRetries } from "./workbench-verify";
import { passingInteractionDriver } from "./workbench-interaction-verify";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("verifyBuild", () => {
  it("passes when typecheck, tests, and renders all succeed", async () => {
    const verdict = await verifyBuild(baseVerifyInput({ session: session(), provider: fakeProvider({}) }));
    expect(verdict.passed).toBe(true);
    expect(verdict.checks.find((c) => c.name === "typecheck")?.status).toBe("pass");
    expect(verdict.checks.find((c) => c.name === "renders")?.status).toBe("pass");
  });

  it("records preview, screenshot, DOM, and console as first-class verification checks", async () => {
    const provider = fakeProvider({});
    provider.inspectPreview = vi.fn(async (_session, url) => ({
      url,
      httpStatus: 200,
      screenshot: { dataUri: "data:image/png;base64,AAAA", width: 1280, height: 720, storageKey: "provider.png" },
      domText: "Workbench preview rendered",
      visibleElements: 7,
      consoleErrors: [],
      pageErrors: [],
    }));

    const verdict = await verifyBuild(baseVerifyInput({ session: session(), provider, skipDefaultRenderInspector: true }));

    expect(Object.fromEntries(verdict.checks.map((check) => [check.name, check.status]))).toMatchObject({
      preview: "pass",
      screenshot: "pass",
      dom: "pass",
      console: "pass",
      renders: "pass",
    });
    expect(verdict.checks.find((check) => check.name === "preview")?.detail).toContain("http://localhost:3000");
    expect(verdict.checks.find((check) => check.name === "dom")?.detail).toContain("visibleElements=7");
    expect(verdict.domSummary).toContain("visibleElements=7");
  });

  it("requires a successful install check when package dependencies changed", async () => {
    const provider = fakeProvider({ commandResults: { "npm install --legacy-peer-deps": { exitCode: 1, output: "registry unavailable" } } });
    const verdict = await verifyBuild(baseVerifyInput({
      session: session(),
      provider,
      commands: { install: "npm install --legacy-peer-deps" },
    }));

    expect(verdict.passed).toBe(false);
    expect(verdict.checks.find((c) => c.name === "install")).toEqual(expect.objectContaining({
      status: "fail",
      detail: expect.stringContaining("registry unavailable"),
    }));
    expect(verdict.failedCommands).toEqual([
      expect.objectContaining({ command: "npm install --legacy-peer-deps", exitCode: 1 }),
    ]);
    expect(verdict.repairPrompt).toContain("npm install --legacy-peer-deps");
  });

  it("requires a successful build check when a build command is configured", async () => {
    const provider = fakeProvider({ commandResults: { "npm run build": { exitCode: 2, output: "vite build failed" } } });
    const verdict = await verifyBuild(baseVerifyInput({
      session: session(),
      provider,
      commands: { build: "npm run build" },
    }));

    expect(verdict.passed).toBe(false);
    expect(verdict.checks.find((c) => c.name === "build")).toEqual(expect.objectContaining({
      status: "fail",
      detail: expect.stringContaining("vite build failed"),
    }));
    expect(verdict.failedCommands).toEqual([
      expect.objectContaining({ command: "npm run build", exitCode: 2 }),
    ]);
  });

  it("fails when tests fail", async () => {
    const verdict = await verifyBuild(baseVerifyInput({ session: session(), provider: fakeProvider({ failed: 2 }) }));
    expect(verdict.passed).toBe(false);
    expect(verdict.checks.find((c) => c.name === "tests")?.status).toBe("fail");
  });

  it("fails tests when test files exist but no test runner is detected", async () => {
    const provider = fakeProvider({});
    provider.listFiles = vi.fn(async () => [
      { name: "App.test.tsx", path: "src/App.test.tsx", isDir: false, sizeBytes: 1, modifiedAt: "2026-06-02T00:00:00.000Z" },
    ]);
    provider.runTests = vi.fn(async () => ({
      passed: 0,
      failed: 0,
      skipped: 1,
      durationMs: 1,
      output: "No test runner detected; skipped.",
      exitCode: 0,
    }));

    const verdict = await verifyBuild(baseVerifyInput({ session: session(), provider }));

    expect(verdict.passed).toBe(false);
    expect(verdict.checks.find((c) => c.name === "tests")).toEqual(expect.objectContaining({
      status: "fail",
      detail: expect.stringContaining("Test files detected but no test runner"),
    }));
  });

  it("skips tests when no test files or runner are detected", async () => {
    const provider = fakeProvider({});
    provider.listFiles = vi.fn(async () => [
      { name: "index.html", path: "index.html", isDir: false, sizeBytes: 1, modifiedAt: "2026-06-02T00:00:00.000Z" },
    ]);
    provider.runTests = vi.fn(async () => ({
      passed: 0,
      failed: 0,
      skipped: 1,
      durationMs: 1,
      output: "No test runner detected; skipped.",
      exitCode: 0,
    }));

    const verdict = await verifyBuild(baseVerifyInput({ session: session(), provider }));

    expect(verdict.passed).toBe(true);
    expect(verdict.checks.find((c) => c.name === "tests")).toEqual(expect.objectContaining({
      status: "skip",
      detail: expect.stringContaining("No test files or test runner detected"),
    }));
  });

  it("fails when typecheck exits non-zero", async () => {
    const verdict = await verifyBuild(baseVerifyInput({ session: session(), provider: fakeProvider({ typecheckExit: 2 }) }));
    expect(verdict.passed).toBe(false);
    expect(verdict.checks.find((c) => c.name === "typecheck")?.status).toBe("fail");
  });

  it("skips typecheck when the project has no TypeScript files or config", async () => {
    const provider = fakeProvider({});
    provider.listFiles = vi.fn(async () => [
      { name: "index.html", path: "index.html", isDir: false, sizeBytes: 1, modifiedAt: "2026-06-02T00:00:00.000Z" },
      { name: "app.js", path: "app.js", isDir: false, sizeBytes: 1, modifiedAt: "2026-06-02T00:00:00.000Z" },
    ]);

    const verdict = await verifyBuild(baseVerifyInput({ session: session(), provider }));

    expect(verdict.checks.find((c) => c.name === "typecheck")?.status).toBe("skip");
    expect(provider.exec).not.toHaveBeenCalledWith(expect.anything(), "npx tsc --noEmit");
  });

  it("skips renders when there is no preview URL but can still pass overall", async () => {
    const verdict = await verifyBuild(baseVerifyInput({ session: session(), provider: fakeProvider({ previewUrl: undefined }) }));
    expect(verdict.checks.find((c) => c.name === "renders")?.status).toBe("skip");
    expect(verdict.passed).toBe(true);
  });

  it("fails renders when the screenshot dataUri is empty", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("preview unreachable");
    }));
    const verdict = await verifyBuild(baseVerifyInput({ session: session(), provider: fakeProvider({ screenshotData: "" }) }));
    expect(verdict.checks.find((c) => c.name === "renders")?.status).toBe("fail");
    expect(verdict.passed).toBe(false);
  });

  it("fails renders when screenshot capture returns the SVG placeholder", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("connection refused");
    }));
    const svg = Buffer.from("<svg><text>Preview placeholder (browser screenshot unavailable)</text><text>Camofox failed: connection refused</text></svg>").toString("base64");
    const verdict = await verifyBuild(baseVerifyInput({
      session: session(),
      provider: fakeProvider({ screenshotData: `data:image/svg+xml;base64,${svg}` }),
    }));
    expect(verdict.checks.find((c) => c.name === "renders")?.status).toBe("fail");
    expect(verdict.checks.find((c) => c.name === "renders")?.detail).toContain("placeholder");
    expect(verdict.checks.find((c) => c.name === "renders")?.detail).toContain("Camofox failed: connection refused");
    expect(verdict.passed).toBe(false);
  });

  it("fails renders when the preview only responds with app HTML but screenshot capture is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<!doctype html><html><body><div id=\"root\">Ember Notes</div><script type=\"module\" src=\"/src/main.tsx\"></script></body></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    })));
    const svg = Buffer.from("<svg><text>Preview placeholder (browser screenshot unavailable)</text><text>Playwright unavailable: launch failed</text></svg>").toString("base64");

    const verdict = await verifyBuild(baseVerifyInput({
      session: session(),
      provider: fakeProvider({ screenshotData: `data:image/svg+xml;base64,${svg}` }),
    }));

    expect(verdict.checks.find((c) => c.name === "renders")?.status).toBe("fail");
    expect(verdict.checks.find((c) => c.name === "renders")?.detail).toContain("screenshot unavailable");
    expect(verdict.checks.find((c) => c.name === "renders")?.detail).toContain("not proof the app rendered");
    expect(verdict.passed).toBe(false);
  });

  it("does not pass renders on a reachable empty HTML shell alone", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<!doctype html><html><body><div id=\"root\"></div><script type=\"module\" src=\"/src/main.tsx\"></script></body></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    })));
    const svg = Buffer.from("<svg><text>Preview placeholder (browser screenshot unavailable)</text><text>Playwright unavailable: launch failed</text></svg>").toString("base64");

    const verdict = await verifyBuild(baseVerifyInput({
      session: session(),
      provider: fakeProvider({ screenshotData: `data:image/svg+xml;base64,${svg}` }),
    }));

    const renders = verdict.checks.find((c) => c.name === "renders");
    expect(renders?.status).toBe("fail");
    expect(renders?.detail).toContain("not proof the app rendered");
    expect(verdict.passed).toBe(false);
  });

  it("fails renders when the DOM inspector reports an empty React root", async () => {
    const verdict = await verifyBuild(baseVerifyInput({
      session: session(),
      provider: fakeProvider({}),
      renderInspector: async () => ({ ok: false, detail: "React root is empty after hydration" }),
    }));

    expect(verdict.checks.find((c) => c.name === "renders")?.status).toBe("fail");
    expect(verdict.checks.find((c) => c.name === "renders")?.detail).toContain("React root is empty");
    expect(verdict.passed).toBe(false);
  });

  it("surfaces console errors from the render inspector as failed verification details", async () => {
    const verdict = await verifyBuild(baseVerifyInput({
      session: session(),
      provider: fakeProvider({}),
      renderInspector: async () => ({
        ok: false,
        detail: "Browser errors: ReferenceError: uuid is not defined",
        consoleErrors: ["ReferenceError: uuid is not defined"],
        domSummary: "root children=0 text=0",
      }),
    }));

    expect(verdict.passed).toBe(false);
    expect(verdict.consoleErrors).toEqual(["ReferenceError: uuid is not defined"]);
    expect(verdict.domSummary).toContain("root children=0");
    expect(verdict.repairPrompt).toContain("ReferenceError");
  });

  it("uses provider-native preview inspection when no render inspector is supplied", async () => {
    const provider = fakeProvider({});
    provider.inspectPreview = vi.fn(async (_session, url) => ({
      url,
      screenshot: { dataUri: "data:image/png;base64,AAAA", width: 1280, height: 720, storageKey: "provider.png" },
      domText: "Hello from the sandbox preview",
      visibleElements: 3,
      consoleErrors: [],
      pageErrors: [],
    }));

    const verdict = await verifyBuild(baseVerifyInput({ session: session(), provider, skipDefaultRenderInspector: true }));

    expect(provider.inspectPreview).toHaveBeenCalledWith(expect.objectContaining({ id: "ws_1" }), "http://localhost:3000");
    expect(verdict.passed).toBe(true);
    expect(verdict.domSummary).toContain("visibleElements=3");
  });

  it("fails objective verification when the rendered app misses concrete requested features", async () => {
    const provider = fakeProvider({});
    provider.listFiles = vi.fn(async () => [
      { name: "App.tsx", path: "src/App.tsx", isDir: false, sizeBytes: 1, modifiedAt: "2026-06-02T00:00:00.000Z" },
    ]);
    provider.inspectPreview = vi.fn(async (_session, url) => ({
      url,
      screenshot: { dataUri: "data:image/png;base64,AAAA", width: 1280, height: 720, storageKey: "provider.png" },
      domText: "Tasks board and project dashboard",
      visibleElements: 5,
      consoleErrors: [],
      pageErrors: [],
    }));

    const verdict = await verifyBuild(baseVerifyInput({ session: session({ objective: "Build a notes app with markdown editor" }), provider }));

    expect(verdict.passed).toBe(false);
    expect(verdict.checks.find((check) => check.name === "objective")).toEqual(expect.objectContaining({
      status: "fail",
      detail: expect.stringContaining("missing notes, markdown, editor"),
    }));
    expect(verdict.repairPrompt).toContain("notes, markdown, editor");
  });

  it("passes objective verification when DOM and file evidence match the requested features", async () => {
    const provider = fakeProvider({});
    provider.listFiles = vi.fn(async () => [
      { name: "MarkdownEditor.tsx", path: "src/notes/MarkdownEditor.tsx", isDir: false, sizeBytes: 1, modifiedAt: "2026-06-02T00:00:00.000Z" },
    ]);
    provider.inspectPreview = vi.fn(async (_session, url) => ({
      url,
      screenshot: { dataUri: "data:image/png;base64,AAAA", width: 1280, height: 720, storageKey: "provider.png" },
      domText: "Notes Markdown Editor",
      visibleElements: 6,
      consoleErrors: [],
      pageErrors: [],
    }));

    const verdict = await verifyBuild(baseVerifyInput({ session: session({ objective: "Build a notes app with markdown editor" }), provider }));

    expect(verdict.passed).toBe(true);
    expect(verdict.checks.find((check) => check.name === "objective")).toEqual(expect.objectContaining({
      status: "pass",
      detail: expect.stringContaining("matched 3/3: notes, markdown, editor"),
    }));
  });

  it("fails when the critic says the product is not actually done", async () => {
    const verdict = await verifyBuild(baseVerifyInput({
      session: session({ objective: "Build a notes app with markdown editor" }),
      provider: fakeProvider({}),
      criticReviewer: async () => ({
        status: "fail",
        detail: "Critic: preview lacks a visible markdown editor workflow",
      }),
    }));

    expect(verdict.passed).toBe(false);
    expect(verdict.checks.find((check) => check.name === "critic")).toEqual(expect.objectContaining({
      status: "fail",
      detail: "Critic: preview lacks a visible markdown editor workflow",
    }));
    expect(verdict.repairPrompt).toContain("visible markdown editor workflow");
  });

  it("records a passing critic review as first-class verification evidence", async () => {
    const verdict = await verifyBuild(baseVerifyInput({
      session: session(),
      provider: fakeProvider({}),
      criticReviewer: async () => ({
        status: "pass",
        detail: "Critic: implementation matches the visible objective",
      }),
    }));

    expect(verdict.passed).toBe(true);
    expect(verdict.checks.find((check) => check.name === "critic")).toEqual(expect.objectContaining({
      status: "pass",
      detail: "Critic: implementation matches the visible objective",
    }));
  });

  it("turns a thrown exec into a fail check without crashing", async () => {
    const provider = fakeProvider({});
    provider.exec = vi.fn(async () => {
      throw new Error("sandbox boom");
    });
    const verdict = await verifyBuild(baseVerifyInput({ session: session(), provider }));
    expect(verdict.checks.find((c) => c.name === "typecheck")?.status).toBe("fail");
    expect(verdict.checks.find((c) => c.name === "typecheck")?.detail).toContain("sandbox boom");
  });

  it("skips lint when no lint command is configured", async () => {
    const verdict = await verifyBuild(baseVerifyInput({ session: session(), provider: fakeProvider({}) }));
    expect(verdict.checks.find((c) => c.name === "lint")?.status).toBe("skip");
  });
});

describe("verifyWithRetries", () => {
  it("returns passed without retrying when first verify is green", async () => {
    const provider = fakeProvider({});
    const heal = vi.fn();
    const verdict = await verifyWithRetries({ ...baseVerifyInput({ session: session(), provider }), maxAttempts: 2, heal });
    expect(verdict.passed).toBe(true);
    expect(heal).not.toHaveBeenCalled();
  });

  it("self-heals on test failure then re-verifies green", async () => {
    let calls = 0;
    const provider = fakeProvider({ failed: 1 });
    provider.runTests = vi.fn(async () => {
      calls++;
      return calls === 1
        ? { passed: 0, failed: 1, skipped: 0, durationMs: 1, output: "FAIL", exitCode: 1 }
        : { passed: 1, failed: 0, skipped: 0, durationMs: 1, output: "ok", exitCode: 0 };
    });
    const heal = vi.fn(async () => {});
    const verdict = await verifyWithRetries({ ...baseVerifyInput({ session: session(), provider }), maxAttempts: 2, heal });
    expect(heal).toHaveBeenCalledTimes(1);
    expect(verdict.passed).toBe(true);
  });

  it("stops after maxAttempts and returns a failing verdict", async () => {
    const provider = fakeProvider({ failed: 1 });
    const heal = vi.fn(async () => {});
    const verdict = await verifyWithRetries({ ...baseVerifyInput({ session: session(), provider }), maxAttempts: 2, heal });
    expect(heal).toHaveBeenCalledTimes(1);
    expect(verdict.passed).toBe(false);
  });
});

function session(overrides: Partial<WorkbenchSession> = {}): WorkbenchSession {
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
    ...overrides,
  };
}

const passingInspector = async () => ({ ok: true, detail: "DOM rendered" });
const passingDriver = passingInteractionDriver();

function baseVerifyInput(input: {
  session: WorkbenchSession;
  provider: WorkbenchProviderAdapter;
  renderInspector?: typeof passingInspector;
  skipDefaultRenderInspector?: boolean;
  interactionDriver?: ReturnType<typeof passingInteractionDriver>;
  commands?: Parameters<typeof verifyBuild>[0]["commands"];
  criticReviewer?: Parameters<typeof verifyBuild>[0]["criticReviewer"];
}) {
  const { skipDefaultRenderInspector, interactionDriver, renderInspector, ...rest } = input;
  return {
    interactionDriver: interactionDriver ?? passingDriver,
    ...(skipDefaultRenderInspector ? {} : { renderInspector: renderInspector ?? passingInspector }),
    ...rest,
  };
}

function fakeProvider(opts: {
  failed?: number;
typecheckExit?: number;
  previewUrl?: string | undefined;
  screenshotData?: string;
  commandResults?: Record<string, { exitCode: number; output: string }>;
}): WorkbenchProviderAdapter {
  const hasPreview = !("previewUrl" in opts) || opts.previewUrl !== undefined;
  const previewUrl = "previewUrl" in opts ? opts.previewUrl : "http://localhost:3000";
  const exec = vi.fn(
    async (_session: WorkbenchSession, command: string): Promise<WorkbenchExecResult> => {
      const result = opts.commandResults?.[command];
      if (result) {
        return {
          stdout: result.output,
          stderr: result.exitCode === 0 ? "" : result.output,
          exitCode: result.exitCode,
          durationMs: 1,
        };
      }
      return {
        stdout: "",
        stderr: "",
        exitCode: opts.typecheckExit ?? 0,
        durationMs: 1,
      };
    },
  );
  const runTests = vi.fn(
    async (): Promise<WorkbenchTestResult> => ({
      passed: opts.failed ? 0 : 3,
      failed: opts.failed ?? 0,
      skipped: 0,
      durationMs: 1,
      output: opts.failed ? "FAIL" : "ok",
      exitCode: opts.failed ? 1 : 0,
    }),
  );
  const screenshot = vi.fn(
    async (): Promise<WorkbenchScreenshotResult> => ({
      dataUri: "screenshotData" in opts ? (opts.screenshotData as string) : "data:image/png;base64,AAAA",
      width: 1280,
      height: 720,
      storageKey: "k",
    }),
  );
  const getPreviewUrl = vi.fn(async () => (hasPreview ? previewUrl : undefined));
  const provider: Partial<WorkbenchProviderAdapter> = {
    name: "fake",
    start: vi.fn(),
    stop: vi.fn(),
    exec,
    readFile: vi.fn(),
    writeFile: vi.fn(),
    listFiles: vi.fn(),
    runTests,
    screenshot,
    getPreviewUrl,
    captureArtifact: vi.fn(),
  };
  return provider as WorkbenchProviderAdapter;
}
