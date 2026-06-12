/**
 * Daytona Workbench Provider
 *
 * Routes workbench sessions to Daytona cloud sandboxes.
 * Requires DAYTONA_API_KEY in the environment. DAYTONA_API_URL and
 * DAYTONA_TARGET are optional and passed through when present.
 */

import { Daytona, type FileInfo, type Sandbox } from "@daytona/sdk";
import { store } from "@/lib/store";
import { makeId, nowIso } from "@/lib/utils";
import {
  registerWorkbenchProvider,
  type WorkbenchCaptureArtifactInput,
  type WorkbenchExecOptions,
  type WorkbenchExecResult,
  type WorkbenchFileEntry,
  type WorkbenchFileTreeOptions,
  type WorkbenchPreviewRun,
  type WorkbenchPreviewInspection,
  type WorkbenchProviderAdapter,
  type WorkbenchSandboxHandle,
  type WorkbenchScreenshotResult,
  type WorkbenchTestResult,
} from "@/lib/workbench-provider";
import type { WorkbenchArtifact, WorkbenchEvent, WorkbenchSession } from "@/lib/types";
import { captureScreenshot } from "@/lib/workbench-screenshot";
import { detectTestRunner } from "@/lib/test-runner";
import { checkCommand, requiresApproval } from "@/lib/workbench-safety";
import { resolveWorkbenchProviderCredentialEnv } from "@/lib/credential-boundary";
import { backgroundPreviewCommand, blockedPreviewCommand, inspectHttpPreview, parsePortFromCommand, DEFAULT_PREVIEW_PORT } from "@/lib/workbench-cloud-preview";
import {
  diffProviderFileTree,
  exportProviderArtifacts,
  getProviderFileTree,
  snapshotProviderFileTree,
} from "@/lib/workbench-provider-files";

type DaytonaSandboxEntry = {
  sandbox: Sandbox;
  workdir: string;
};

const sandboxes = new Map<string, DaytonaSandboxEntry>();

const DEFAULT_TIMEOUT_SECONDS = 60;
const PREVIEW_EXPIRES_SECONDS = 3600;
const DEFAULT_WORKDIR = "/workspace";
const PREVIEW_PORTS = [3000, 5173, 4200, 8080, 4000, 8000];
const REDACTED_ENV_KEYS = new Set([
  "GITHUB_TOKEN",
  "DATABASE_URL",
  "DIRECT_URL",
  "TEST_DATABASE_URL",
  "SECRET_ENCRYPTION_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "E2B_API_KEY",
  "DAYTONA_API_KEY",
]);

const daytonaProvider: WorkbenchProviderAdapter = {
  name: "daytona",

  async start(session: WorkbenchSession): Promise<WorkbenchSandboxHandle> {
    const existing = sandboxes.get(session.id);
    if (existing) {
      return {
        provider: "daytona",
        providerSessionId: existing.sandbox.id,
        workdir: existing.workdir,
        previewMode: "provider_url",
      };
    }
    const credentials = await resolveWorkbenchProviderCredentialEnv(session.companyId, "daytona");
    if (!credentials.env.DAYTONA_API_KEY) {
      throw new Error("DAYTONA_API_KEY is required to start a Daytona workbench provider");
    }

    const daytona = createClient(credentials.env);
    const sandbox = await daytona.create({
      language: "typescript",
      name: sandboxName(session),
      public: false,
      autoStopInterval: Math.ceil(session.metadata.maxRuntimeSeconds / 60),
      autoArchiveInterval: 60,
      autoDeleteInterval: 60,
      networkBlockAll: session.metadata.networkPolicy === "deny_all",
      labels: {
        companyId: session.companyId,
        workbenchSessionId: session.id,
        agentRole: session.agentRole,
      },
    }, { timeout: DEFAULT_TIMEOUT_SECONDS });

    const baseWorkdir = await sandbox.getWorkDir() ?? DEFAULT_WORKDIR;
    const workdir = daytonaSessionWorkdir(baseWorkdir, session);
    if (workdir !== baseWorkdir) {
      await sandbox.process.executeCommand(
        `mkdir -p ${shellQuote(workdir)}`,
        baseWorkdir,
        undefined,
        DEFAULT_TIMEOUT_SECONDS,
      );
    }
    sandboxes.set(session.id, { sandbox, workdir });

    await store.addWorkbenchEvent({
      companyId: session.companyId,
      sessionId: session.id,
      type: "system",
      status: "completed",
      title: "Daytona sandbox ready",
      content: `Sandbox ${sandbox.id} started with ${credentials.source} credentials`,
    });

    return {
      provider: "daytona",
      providerSessionId: sandbox.id,
      workdir,
      previewMode: "provider_url",
      expiresAt: new Date(Date.now() + session.metadata.maxRuntimeSeconds * 1000).toISOString(),
    };
  },

  async restore(session: WorkbenchSession, handle: WorkbenchSandboxHandle): Promise<WorkbenchSandboxHandle> {
    const existing = sandboxes.get(session.id);
    if (existing) {
      return {
        provider: "daytona",
        providerSessionId: existing.sandbox.id,
        workdir: existing.workdir,
        previewMode: handle.previewMode,
        providerUrl: handle.providerUrl,
        expiresAt: handle.expiresAt,
      };
    }
    if (!handle.providerSessionId) {
      throw new Error("Cannot restore Daytona workbench provider without a providerSessionId");
    }
    const credentials = await resolveWorkbenchProviderCredentialEnv(session.companyId, "daytona");
    if (!credentials.env.DAYTONA_API_KEY) {
      throw new Error("DAYTONA_API_KEY is required to restore a Daytona workbench provider");
    }

    const daytona = createClient(credentials.env);
    const sandbox = await daytona.get(handle.providerSessionId);
    const baseWorkdir = handle.workdir ?? await sandbox.getWorkDir() ?? DEFAULT_WORKDIR;
    const workdir = daytonaSessionWorkdir(baseWorkdir, session);
    sandboxes.set(session.id, { sandbox, workdir });

    await store.addWorkbenchEvent({
      companyId: session.companyId,
      sessionId: session.id,
      type: "system",
      status: "completed",
      title: "Daytona sandbox restored",
      content: `Sandbox ${sandbox.id} restored with ${credentials.source} credentials`,
    });

    return {
      provider: "daytona",
      providerSessionId: sandbox.id,
      workdir,
      previewMode: handle.previewMode,
      providerUrl: handle.providerUrl,
      expiresAt: handle.expiresAt,
    };
  },

  async stop(session: WorkbenchSession): Promise<void> {
    const entry = sandboxes.get(session.id);
    if (!entry) return;
    sandboxes.delete(session.id);
    try {
      await entry.sandbox.stop(DEFAULT_TIMEOUT_SECONDS);
      await entry.sandbox.delete(DEFAULT_TIMEOUT_SECONDS);
    } catch {
      // best-effort cleanup
    }
  },

  async exec(
    session: WorkbenchSession,
    command: string,
    options?: WorkbenchExecOptions,
  ): Promise<WorkbenchExecResult> {
    const entry = getSandbox(session.id);
    const start = Date.now();

    if (requiresApproval(command)) {
      await store.addWorkbenchEvent({
        companyId: session.companyId,
        sessionId: session.id,
        type: "shell",
        status: "needs_approval",
        title: "Approval required",
        content: `Command requires approval before execution: \`${command}\``,
        command,
      });
      return {
        stdout: "",
        stderr: "Approval required before executing this command.",
        exitCode: 1,
        durationMs: Date.now() - start,
        blocked: true,
        blockedReason: "external_write_requires_approval",
      };
    }

    const safety = checkCommand(command);
    if (safety.blocked) {
      await store.addWorkbenchEvent({
        companyId: session.companyId,
        sessionId: session.id,
        type: "shell",
        status: "failed",
        title: "Command blocked",
        content: safety.reason ?? "Command is not allowed.",
        command,
      });
      return {
        stdout: "",
        stderr: safety.reason ?? "Command blocked by safety policy.",
        exitCode: 126,
        durationMs: Date.now() - start,
        blocked: true,
        blockedReason: safety.reason,
      };
    }

    await store.addWorkbenchEvent({
      companyId: session.companyId,
      sessionId: session.id,
      type: "shell",
      status: "running",
      title: `$ ${command.slice(0, 80)}`,
      content: "Running command in Daytona sandbox...",
      command,
    });

    const result = await entry.sandbox.process.executeCommand(
      command,
      options?.cwd ?? entry.workdir,
      sanitizeSandboxEnv(options?.env),
      timeoutSeconds(options?.timeoutMs),
    );
    const artifacts = result.artifacts as { stdout?: string; stderr?: string } | undefined;
    const stdout = artifacts?.stdout ?? result.result ?? "";
    const stderr = artifacts?.stderr ?? "";
    const exitCode = result.exitCode ?? 0;

    await store.addWorkbenchEvent({
      companyId: session.companyId,
      sessionId: session.id,
      type: "shell",
      status: exitCode === 0 ? "completed" : "failed",
      title: `$ ${command.slice(0, 80)}`,
      content: [
        stdout.slice(0, 2000),
        stderr ? `[stderr] ${stderr.slice(0, 500)}` : "",
      ].filter(Boolean).join("\n") || "(no output)",
      command,
    });

    return {
      stdout,
      stderr,
      exitCode,
      durationMs: Date.now() - start,
    };
  },

  async readFile(session: WorkbenchSession, filePath: string): Promise<string> {
    const entry = getSandbox(session.id);
    const content = await entry.sandbox.fs.downloadFile(filePath, DEFAULT_TIMEOUT_SECONDS);
    return content.toString("utf8");
  },

  async writeFile(session: WorkbenchSession, filePath: string, content: string): Promise<void> {
    const entry = getSandbox(session.id);
    await entry.sandbox.fs.uploadFile(Buffer.from(content, "utf8"), filePath, DEFAULT_TIMEOUT_SECONDS);
  },

  async listFiles(session: WorkbenchSession, dirPath = "."): Promise<WorkbenchFileEntry[]> {
    const entry = getSandbox(session.id);
    const entries = await entry.sandbox.fs.listFiles(dirPath);
    return entries.map((file) => toWorkbenchFileEntry(file, dirPath));
  },

  async getFileTree(session: WorkbenchSession, options?: WorkbenchFileTreeOptions): Promise<WorkbenchFileEntry[]> {
    return getProviderFileTree(daytonaProvider, session, options);
  },

  async diffSinceCheckpoint(session: WorkbenchSession, checkpointHash?: string) {
    return diffProviderFileTree(daytonaProvider, session, checkpointHash);
  },

  async snapshot(session: WorkbenchSession) {
    const entry = getSandbox(session.id);
    return snapshotProviderFileTree(daytonaProvider, session, entry.sandbox.id);
  },

  async exportArtifacts(session: WorkbenchSession) {
    return exportProviderArtifacts(daytonaProvider, session);
  },

  async runTests(session: WorkbenchSession, command?: string): Promise<WorkbenchTestResult> {
    const start = Date.now();
    const cmd = command ?? (await detectTestRunner(DEFAULT_WORKDIR)).command;
    if (!cmd) {
      return {
        passed: 0,
        failed: 0,
        skipped: 0,
        durationMs: 0,
        output: "No test runner detected",
        exitCode: 1,
      };
    }

    const result = await daytonaProvider.exec(session, cmd, {
      timeoutMs: DEFAULT_TIMEOUT_SECONDS * 5 * 1000,
    });
    const output = `${result.stdout}\n${result.stderr}`.trim();
    const passed = parseInt(output.match(/(\d+)\s+pass(?:ed)?/i)?.[1] ?? "0", 10);
    const failed = parseInt(output.match(/(\d+)\s+fail(?:ed)?/i)?.[1] ?? "0", 10);
    const skipped = parseInt(output.match(/(\d+)\s+skip(?:ped)?/i)?.[1] ?? "0", 10);

    return { passed, failed, skipped, durationMs: Date.now() - start, output, exitCode: result.exitCode };
  },

  async screenshot(
    session: WorkbenchSession,
    options?: { url?: string; width?: number; height?: number },
  ): Promise<WorkbenchScreenshotResult> {
    const previewUrl = options?.url ?? (await daytonaProvider.getPreviewUrl(session));
    if (!previewUrl) {
      return { dataUri: "", width: 0, height: 0, storageKey: "" };
    }
    const storageKey = `daytona/${session.id}/screenshot`;
    return captureScreenshot(previewUrl, {
      width: options?.width,
      height: options?.height,
      storageKey,
      sessionId: session.id,
    });
  },

  async getPreviewUrl(session: WorkbenchSession): Promise<string | undefined> {
    const entry = sandboxes.get(session.id);
    if (!entry) return undefined;

    for (const port of PREVIEW_PORTS) {
      try {
        const preview = await entry.sandbox.getSignedPreviewUrl(port, PREVIEW_EXPIRES_SECONDS);
        return preview.url;
      } catch {
        // port not exposed; continue
      }
    }
    return undefined;
  },

  async startPreview(
    session: WorkbenchSession,
    command: string,
    portHint?: number,
  ): Promise<WorkbenchPreviewRun> {
    const entry = getSandbox(session.id);
    const start = Date.now();
    // Match the listen port to what the dev server actually binds to (starter
    // template = 3000). Defaulting to Vite's 5173 broke the preview URL.
    const port = portHint ?? parsePortFromCommand(command) ?? DEFAULT_PREVIEW_PORT;

    const blocked = await blockedPreviewCommand(session, command, start);
    if (blocked) return { command, port, result: blocked };

    const result = await entry.sandbox.process.executeCommand(
      backgroundPreviewCommand(command, session.id),
      entry.workdir,
      sanitizeSandboxEnv({ PORT: String(port) }),
      DEFAULT_TIMEOUT_SECONDS,
    );
    const stdout = result.artifacts?.stdout ?? result.result ?? "";
    const exitCode = result.exitCode ?? 0;
    const preview = await entry.sandbox.getSignedPreviewUrl(port, PREVIEW_EXPIRES_SECONDS);

    await store.addWorkbenchEvent({
      companyId: session.companyId,
      sessionId: session.id,
      type: "deploy",
      status: exitCode === 0 ? "completed" : "failed",
      title: "Daytona preview started",
      content: preview.url,
      command,
    });

    return {
      command,
      url: preview.url,
      port,
      result: {
        stdout,
        stderr: "",
        exitCode,
        durationMs: Date.now() - start,
      },
    };
  },

  async inspectPreview(session: WorkbenchSession, url: string): Promise<WorkbenchPreviewInspection> {
    const screenshot = await this.screenshot(session, { url });
    return inspectHttpPreview(url, screenshot);
  },

  async captureArtifact(
    session: WorkbenchSession,
    input: WorkbenchCaptureArtifactInput,
  ): Promise<{ artifact: WorkbenchArtifact; event: WorkbenchEvent }> {
    const sizeBytes = input.sizeBytes ?? Buffer.byteLength(input.content ?? "", "utf8");
    const storageKey = `daytona/${session.id}/${makeId("artifact")}`;

    const artifact = await store.addWorkbenchArtifact({
      companyId: session.companyId,
      sessionId: session.id,
      kind: input.kind,
      title: input.title,
      storageKey,
      mimeType: input.mimeType ?? "application/octet-stream",
      sizeBytes,
      createdByAgent: input.createdByAgent ?? session.agentRole,
      sourceEventId: input.sourceEventId,
      path: input.path,
      previewUrl: input.previewUrl,
      metadata: input.metadata,
    });

    const event = await store.addWorkbenchEvent({
      companyId: session.companyId,
      sessionId: session.id,
      type: "artifact",
      status: "completed",
      title: input.title,
      content: input.content ?? "",
      artifactId: artifact.id,
    });

    return { artifact, event };
  },
};

registerWorkbenchProvider(daytonaProvider);

export { daytonaProvider };

function createClient(env: Record<string, string>) {
  return new Daytona({
    apiKey: env.DAYTONA_API_KEY,
    apiUrl: env.DAYTONA_API_URL,
    target: env.DAYTONA_TARGET,
  });
}

function getSandbox(sessionId: string): DaytonaSandboxEntry {
  const entry = sandboxes.get(sessionId);
  if (!entry) throw new Error(`No Daytona sandbox for session ${sessionId}`);
  return entry;
}

function sandboxName(session: WorkbenchSession) {
  return `trent-${session.id.replace(/[^a-z0-9-]/gi, "-").slice(0, 40)}`;
}

function daytonaSessionWorkdir(baseWorkdir: string, session: WorkbenchSession) {
  const base = baseWorkdir.replace(/\/+$/, "") || DEFAULT_WORKDIR;
  if (!/\/home\/daytona$/i.test(base)) return base;
  const suffix = session.id.replace(/[^a-z0-9_-]/gi, "_").slice(0, 48);
  return `${base}/trent-workbench-${suffix}`;
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function timeoutSeconds(timeoutMs?: number) {
  return Math.ceil((timeoutMs ?? DEFAULT_TIMEOUT_SECONDS * 1000) / 1000);
}

function sanitizeSandboxEnv(env?: Record<string, string>) {
  if (!env) return undefined;
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !REDACTED_ENV_KEYS.has(key)),
  );
}

function toWorkbenchFileEntry(file: FileInfo, dirPath: string): WorkbenchFileEntry {
  const base = dirPath === "." ? "" : dirPath.replace(/\/$/, "");
  return {
    name: file.name,
    path: base ? `${base}/${file.name}` : file.name,
    isDir: file.isDir,
    sizeBytes: file.size,
    modifiedAt: file.modTime || nowIso(),
  };
}
