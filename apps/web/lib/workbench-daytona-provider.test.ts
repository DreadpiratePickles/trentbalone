import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkbenchSession } from "@/lib/types";

const {
  MockDaytona,
  mockCreate,
  mockDaytonaConstructor,
  mockDelete,
  mockDownloadFile,
  mockExecuteCommand,
  mockGet,
  mockGetSignedPreviewUrl,
  mockListFiles,
  mockStop,
  mockUploadFile,
  mockAddWorkbenchArtifact,
  mockAddWorkbenchEvent,
  mockCaptureScreenshot,
  mockResolveWorkbenchProviderCredentialEnv,
} = vi.hoisted(() => {
  const mockCreate = vi.fn();
  const mockGet = vi.fn();
  const mockDaytonaConstructor = vi.fn();
  class MockDaytona {
    constructor(config?: Record<string, unknown>) {
      mockDaytonaConstructor(config);
    }

    create = mockCreate;
    get = mockGet;
  }

  return {
    MockDaytona,
    mockCreate,
    mockDaytonaConstructor,
    mockDelete: vi.fn(),
    mockDownloadFile: vi.fn(),
    mockExecuteCommand: vi.fn(),
    mockGet,
    mockGetSignedPreviewUrl: vi.fn(),
    mockListFiles: vi.fn(),
    mockStop: vi.fn(),
    mockUploadFile: vi.fn(),
    mockAddWorkbenchArtifact: vi.fn(),
    mockAddWorkbenchEvent: vi.fn(),
    mockCaptureScreenshot: vi.fn(),
    mockResolveWorkbenchProviderCredentialEnv: vi.fn(),
  };
});

vi.mock("@daytona/sdk", () => ({ Daytona: MockDaytona }));

vi.mock("@/lib/store", () => ({
  store: {
    addWorkbenchEvent: mockAddWorkbenchEvent,
    addWorkbenchArtifact: mockAddWorkbenchArtifact,
  },
}));

vi.mock("@/lib/workbench-screenshot", () => ({
  captureScreenshot: mockCaptureScreenshot,
}));

vi.mock("@/lib/test-runner", () => ({
  detectTestRunner: vi.fn().mockResolvedValue({ command: "npm test" }),
}));

vi.mock("@/lib/credential-boundary", () => ({
  resolveWorkbenchProviderCredentialEnv: mockResolveWorkbenchProviderCredentialEnv,
}));

vi.mock("playwright", () => ({
  chromium: {
    launch: vi.fn(async () => ({
      close: vi.fn(),
      newPage: vi.fn(async () => ({
        goto: vi.fn(async () => ({ status: () => 200 })),
        waitForLoadState: vi.fn(async () => undefined),
        waitForTimeout: vi.fn(async () => undefined),
        waitForSelector: vi.fn(async () => undefined),
        content: vi.fn(async () => "<html><body><button>Save</button><h1>Cloud notes app</h1></body></html>"),
        getByText: vi.fn(() => ({
          first: () => ({ waitFor: vi.fn(async () => undefined) }),
        })),
        evaluate: vi.fn(async () => ({ bodyText: "Cloud notes app Save", visibleElements: 3 })),
        on: vi.fn(),
      })),
    })),
  },
}));

import { daytonaProvider } from "./workbench-daytona-provider";

describe("daytona workbench provider safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DAYTONA_API_KEY = "global_daytona_key";
    process.env.DAYTONA_API_URL = "https://app.daytona.io/api";
    process.env.DAYTONA_TARGET = "us";
    mockResolveWorkbenchProviderCredentialEnv.mockResolvedValue({
      source: "company",
      env: {
        DAYTONA_API_KEY: "tenant_daytona_key",
        DAYTONA_API_URL: "https://tenant.daytona.example/api",
        DAYTONA_TARGET: "eu",
      },
    });
    mockCreate.mockResolvedValue(sandbox());
    mockGet.mockResolvedValue(sandbox("daytona_restored_1"));
    mockExecuteCommand.mockResolvedValue({ result: "ok", exitCode: 0, artifacts: { stdout: "ok" } });
    mockDownloadFile.mockResolvedValue(Buffer.from("file contents"));
    mockListFiles.mockResolvedValue([
      { name: "src", isDir: true, modTime: "2026-05-30T00:00:00.000Z", size: 0 },
      { name: "package.json", isDir: false, modTime: "2026-05-30T00:00:00.000Z", size: 120 },
    ]);
    mockGetSignedPreviewUrl.mockResolvedValue({ url: "https://3000-token.proxy.daytona.work", token: "token" });
    mockCaptureScreenshot.mockResolvedValue({
      dataUri: "data:image/png;base64,real",
      width: 1280,
      height: 720,
      storageKey: "daytona/screenshot",
    });
    mockAddWorkbenchArtifact.mockResolvedValue({ id: "artifact_1" });
    mockAddWorkbenchEvent.mockResolvedValue({ id: "event_1" });
  });

  it("requires DAYTONA_API_KEY before creating a sandbox", async () => {
    mockResolveWorkbenchProviderCredentialEnv.mockResolvedValue({ source: "missing", env: {} });

    await expect(daytonaProvider.start(session("missing_key"))).rejects.toThrow(
      "DAYTONA_API_KEY is required to start a Daytona workbench provider",
    );
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("creates a Daytona sandbox with explicit config and records a ready event", async () => {
    await daytonaProvider.start(session("start"));

    expect(mockResolveWorkbenchProviderCredentialEnv).toHaveBeenCalledWith("co_1", "daytona");
    expect(mockDaytonaConstructor).toHaveBeenCalledWith({
      apiKey: "tenant_daytona_key",
      apiUrl: "https://tenant.daytona.example/api",
      target: "eu",
    });
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      language: "typescript",
      name: "trent-start",
      public: false,
      autoStopInterval: 30,
    }), { timeout: 60 });
    expect(mockAddWorkbenchEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "system",
      status: "completed",
      title: "Daytona sandbox ready",
      content: expect.stringContaining("daytona_sb_1"),
    }));
  });

  it("does not clone repoUrl during sandbox start because imports need credentials", async () => {
    const current = { ...session("repo-start"), repoUrl: "https://github.com/private/repo.git" };

    await daytonaProvider.start(current);

    expect(mockExecuteCommand).not.toHaveBeenCalledWith(
      expect.stringContaining("git clone"),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("uses a clean session subdirectory when Daytona reports the home directory", async () => {
    const homeSandbox = sandbox("home_dir_sb");
    homeSandbox.getWorkDir.mockResolvedValueOnce("/home/daytona");
    mockCreate.mockResolvedValueOnce(homeSandbox);

    const handle = await daytonaProvider.start(session("home-dir"));

    expect(mockExecuteCommand).toHaveBeenCalledWith(
      "mkdir -p '/home/daytona/trent-workbench-home-dir'",
      "/home/daytona",
      undefined,
      60,
    );
    expect(handle).toEqual(expect.objectContaining({
      workdir: "/home/daytona/trent-workbench-home-dir",
    }));
  });

  it("restores a persisted Daytona sandbox id instead of creating a new sandbox", async () => {
    const current = session("restore");

    const handle = await daytonaProvider.restore?.(current, {
      provider: "daytona",
      providerSessionId: "persisted-daytona-sandbox",
      workdir: "/persisted/workdir",
      previewMode: "provider_url",
      providerUrl: "https://persisted.preview",
      expiresAt: "2026-06-06T00:00:00.000Z",
    });

    expect(mockResolveWorkbenchProviderCredentialEnv).toHaveBeenCalledWith("co_1", "daytona");
    expect(mockGet).toHaveBeenCalledWith("persisted-daytona-sandbox");
    expect(mockCreate).not.toHaveBeenCalled();
    expect(handle).toEqual(expect.objectContaining({
      provider: "daytona",
      providerSessionId: "daytona_restored_1",
      workdir: "/persisted/workdir",
      previewMode: "provider_url",
      providerUrl: "https://persisted.preview",
      expiresAt: "2026-06-06T00:00:00.000Z",
    }));

    await daytonaProvider.exec(current, "npm test");
    expect(mockExecuteCommand).toHaveBeenCalledWith("npm test", "/persisted/workdir", undefined, 60);
  });

  it("requires approval before executing external writes", async () => {
    const current = session("approval");
    await daytonaProvider.start(current);

    const result = await daytonaProvider.exec(current, "git push origin main");

    expect(result).toEqual(expect.objectContaining({
      blocked: true,
      blockedReason: "external_write_requires_approval",
      exitCode: 1,
    }));
    expect(mockExecuteCommand).not.toHaveBeenCalledWith("git push origin main", expect.anything());
    expect(mockAddWorkbenchEvent).toHaveBeenCalledWith(expect.objectContaining({
      status: "needs_approval",
      command: "git push origin main",
    }));
  });

  it("blocks unsafe commands before they reach Daytona", async () => {
    const current = session("blocked");
    await daytonaProvider.start(current);

    const result = await daytonaProvider.exec(current, "rm -rf /");

    expect(result).toEqual(expect.objectContaining({
      blocked: true,
      exitCode: 126,
    }));
    expect(mockExecuteCommand).not.toHaveBeenCalledWith("rm -rf /", expect.anything());
    expect(mockAddWorkbenchEvent).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed",
      title: "Command blocked",
      command: "rm -rf /",
    }));
  });

  it("strips known secret environment variables and records replayable command events", async () => {
    const current = session("exec");
    await daytonaProvider.start(current);

    const result = await daytonaProvider.exec(current, "npm test", {
      env: {
        DAYTONA_API_KEY: "real-token",
        GITHUB_TOKEN: "ghp_secret",
        TRENT_PREVIEW: "true",
      },
      timeoutMs: 90_000,
    });

    expect(result.exitCode).toBe(0);
    expect(mockExecuteCommand).toHaveBeenCalledWith("npm test", "/workspace", { TRENT_PREVIEW: "true" }, 90);
    expect(mockAddWorkbenchEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "shell",
      status: "running",
      title: "$ npm test",
      command: "npm test",
    }));
    expect(mockAddWorkbenchEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "shell",
      status: "completed",
      content: "ok",
      command: "npm test",
    }));
  });

  it("preserves command stderr in failed Daytona exec results and events", async () => {
    const current = session("stderr");
    mockExecuteCommand.mockResolvedValueOnce({
      result: "",
      exitCode: 128,
      artifacts: { stdout: "", stderr: "fatal: could not read Username" },
    });
    await daytonaProvider.start(current);

    const result = await daytonaProvider.exec(current, "git clone https://github.com/private/repo.git .");

    expect(result).toEqual(expect.objectContaining({
      exitCode: 128,
      stderr: "fatal: could not read Username",
    }));
    expect(mockAddWorkbenchEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "shell",
      status: "failed",
      content: expect.stringContaining("[stderr] fatal: could not read Username"),
    }));
  });

  it("supports file operations and signed preview URLs", async () => {
    const current = session("files");
    await daytonaProvider.start(current);

    await daytonaProvider.writeFile(current, "src/App.tsx", "export default function App() { return null; }");
    const content = await daytonaProvider.readFile(current, "src/App.tsx");
    const files = await daytonaProvider.listFiles(current, ".");
    const preview = await daytonaProvider.getPreviewUrl(current);

    expect(mockUploadFile).toHaveBeenCalledWith(
      Buffer.from("export default function App() { return null; }", "utf8"),
      "src/App.tsx",
      60,
    );
    expect(mockDownloadFile).toHaveBeenCalledWith("src/App.tsx", 60);
    expect(content).toBe("file contents");
    expect(files.map((file) => file.name)).toEqual(["src", "package.json"]);
    expect(mockGetSignedPreviewUrl).toHaveBeenCalledWith(3000, 3600);
    expect(preview).toBe("https://3000-token.proxy.daytona.work");
  });

  it("provides recursive file tree, snapshot, diff, and export manifest", async () => {
    mockListFiles.mockImplementation(async (dirPath = ".") => {
      if (dirPath === ".") {
        return [
          { name: "src", isDir: true, modTime: "2026-05-30T00:00:00.000Z", size: 0 },
          { name: "package.json", isDir: false, modTime: "2026-05-30T00:00:00.000Z", size: 120 },
          { name: "node_modules", isDir: true, modTime: "2026-05-30T00:00:00.000Z", size: 0 },
        ];
      }
      if (dirPath === "src") {
        return [
          { name: "App.tsx", isDir: false, modTime: "2026-05-30T00:00:00.000Z", size: 240 },
          { name: "nested", isDir: true, modTime: "2026-05-30T00:00:00.000Z", size: 0 },
        ];
      }
      if (dirPath === "src/nested") {
        return [{ name: "util.ts", isDir: false, modTime: "2026-05-30T00:00:00.000Z", size: 80 }];
      }
      return [];
    });
    const current = session("tree");
    await daytonaProvider.start(current);

    const tree = await daytonaProvider.getFileTree?.(current, { depth: 3 });
    const snapshot = await daytonaProvider.snapshot?.(current);
    const diff = await daytonaProvider.diffSinceCheckpoint?.(current, "old-hash");
    const exported = await daytonaProvider.exportArtifacts?.(current);

    expect(tree?.map((file) => file.path)).toEqual([
      "package.json",
      "src",
      "src/App.tsx",
      "src/nested",
      "src/nested/util.ts",
    ]);
    expect(snapshot).toEqual(expect.objectContaining({
      fileTreeHash: expect.any(String),
      metadata: expect.objectContaining({
        fileCount: 3,
        providerSessionId: "daytona_sb_1",
      }),
    }));
    expect(diff).toEqual(expect.objectContaining({
      changedPaths: ["package.json", "src/App.tsx", "src/nested/util.ts"],
      fromHash: "old-hash",
      toHash: expect.any(String),
    }));
    expect(mockAddWorkbenchArtifact).toHaveBeenCalledWith(expect.objectContaining({
      kind: "export",
      title: "Workbench artifact manifest",
    }));
    expect(mockAddWorkbenchEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "artifact",
      content: expect.stringContaining("- file src/App.tsx"),
    }));
    expect(exported?.artifact).toEqual({ id: "artifact_1" });
    expect(exported?.event).toEqual({ id: "event_1" });
  });

  it("starts a managed preview process and returns a signed preview URL", async () => {
    const current = session("preview");
    await daytonaProvider.start(current);

    const preview = await daytonaProvider.startPreview?.(current, "npm run dev", 5173);

    expect(mockExecuteCommand).toHaveBeenCalledWith(
      expect.stringContaining("nohup npm run dev"),
      "/workspace",
      { PORT: "5173" },
      60,
    );
    expect(mockGetSignedPreviewUrl).toHaveBeenCalledWith(5173, 3600);
    expect(preview).toEqual(expect.objectContaining({
      command: "npm run dev",
      url: "https://3000-token.proxy.daytona.work",
      port: 5173,
      result: expect.objectContaining({ exitCode: 0 }),
    }));
  });

  it("inspects a preview with screenshot and DOM evidence", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => ({
      status: 200,
      text: async () => "<main><h1>Cloud notes app</h1><button>Save</button></main>",
    })));
    const current = session("inspect");
    await daytonaProvider.start(current);
    await daytonaProvider.startPreview!(current, "npm run dev -- --host 0.0.0.0", 3000);

    try {
      const inspection = await daytonaProvider.inspectPreview?.(current, "https://preview.daytona.test");

      expect(mockCaptureScreenshot).toHaveBeenCalledWith("https://preview.daytona.test", expect.objectContaining({
        storageKey: "daytona/inspect/screenshot",
        sessionId: "inspect",
        extraHTTPHeaders: { "X-Access-Token": "token" },
      }));
      expect(inspection).toEqual(expect.objectContaining({
        url: "https://preview.daytona.test",
        httpStatus: 200,
        domText: expect.stringContaining("Cloud notes"),
        visibleElements: expect.any(Number),
        consoleErrors: [],
        diagnostics: expect.objectContaining({
          proxyAuthUsed: true,
          domProbeSource: "browser",
        }),
      }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("deletes the sandbox when stopping an ephemeral workbench session", async () => {
    const current = session("stop");
    await daytonaProvider.start(current);

    await daytonaProvider.stop(current);

    expect(mockStop).toHaveBeenCalledWith(60);
    expect(mockDelete).toHaveBeenCalledWith(60);
  });
});

function sandbox(id = "daytona_sb_1") {
  return {
    id,
    getWorkDir: vi.fn().mockResolvedValue("/workspace"),
    process: { executeCommand: mockExecuteCommand },
    fs: {
      downloadFile: mockDownloadFile,
      uploadFile: mockUploadFile,
      listFiles: mockListFiles,
    },
    getSignedPreviewUrl: mockGetSignedPreviewUrl,
    stop: mockStop,
    delete: mockDelete,
  };
}

function session(id: string): WorkbenchSession {
  return {
    id,
    companyId: "co_1",
    agentRole: "engineer",
    agentMode: "build",
    messageCount: 0,
    status: "running",
    provider: "daytona",
    objective: "Run tests",
    costCents: 0,
    createdAt: "2026-05-30T00:00:00.000Z",
    updatedAt: "2026-05-30T00:00:00.000Z",
    metadata: {
      networkPolicy: "allowlist",
      allowedHosts: ["github.com"],
      maxRuntimeSeconds: 1800,
      maxCostCents: 250,
      approvalRequiredFor: ["git_push"],
      rollbackAvailable: true,
    },
  };
}
