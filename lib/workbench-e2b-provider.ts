/**
 * E2B Workbench Provider
 *
 * Routes workbench sessions to E2B cloud sandboxes.
 * Requires E2B_API_KEY in the environment.
 */

import { Sandbox } from "e2b";
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
import { checkCommand, requiresApproval, safePosixPath, checkNetworkPolicy, redactSecretEnv } from "@/lib/workbench-safety";
import { resolveWorkbenchProviderCredentialEnv } from "@/lib/credential-boundary";
import { blockedPreviewCommand, inspectHttpPreview, parsePortFromCommand, DEFAULT_PREVIEW_PORT } from "@/lib/workbench-cloud-preview";
import {
  diffProviderFileTree,
  exportProviderArtifacts,
  getProviderFileTree,
  normalizeWorkbenchPath,
  snapshotProviderFileTree,
} from "@/lib/workbench-provider-files";

const sandboxes = new Map<string, Sandbox>();

function getSandbox(sessionId: string): Sandbox {
  const sb = sandboxes.get(sessionId);
  if (!sb) throw new Error(`No E2B sandbox for session ${sessionId}`);
  return sb;
}

const DEFAULT_TEMPLATE = process.env.E2B_TEMPLATE ?? "base";
const DEFAULT_WORKDIR = "/home/user";
const DEFAULT_SANDBOX_TIMEOUT_MS = Number(process.env.E2B_SANDBOX_TIMEOUT_MS ?? 30 * 60 * 1000);
const DEFAULT_EXEC_TIMEOUT_MS = Number(process.env.E2B_EXEC_TIMEOUT_MS ?? 5 * 60 * 1000);

type E2BCommandResult = {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
};

const e2bProvider: WorkbenchProviderAdapter = {
  name: "e2b",

  async start(session: WorkbenchSession): Promise<WorkbenchSandboxHandle> {
    const existing = sandboxes.get(session.id);
    if (existing) {
      return {
        provider: "e2b",
        providerSessionId: existing.sandboxId,
        workdir: DEFAULT_WORKDIR,
        previewMode: "provider_url",
      };
    }
    const credentials = await resolveWorkbenchProviderCredentialEnv(session.companyId, "e2b");
    const apiKey = credentials.env.E2B_API_KEY;
    if (!apiKey) throw new Error("E2B_API_KEY is required to start an E2B workbench provider");

    const sb = await Sandbox.create(DEFAULT_TEMPLATE, {
      apiKey,
      timeoutMs: DEFAULT_SANDBOX_TIMEOUT_MS,
      secure: false, // public preview URLs (no X-Access-Token required on *.e2b.app)
    });

    sandboxes.set(session.id, sb);

    if (session.repoUrl) {
      const branch = session.branchName ? `--branch ${session.branchName} ` : "";
      await sb.commands.run(
        `git clone --depth=1 ${branch}${session.repoUrl} ${DEFAULT_WORKDIR}`,
        { timeoutMs: DEFAULT_EXEC_TIMEOUT_MS }
      );
    }

    await store.addWorkbenchEvent({
      companyId: session.companyId,
      sessionId: session.id,
      type: "system",
      status: "completed",
      title: "E2B sandbox ready",
      content: `Sandbox ${sb.sandboxId} started with ${credentials.source} credentials`,
    });

    return {
      provider: "e2b",
      providerSessionId: sb.sandboxId,
      workdir: DEFAULT_WORKDIR,
      previewMode: "provider_url",
    };
  },

  async restore(session: WorkbenchSession, handle: WorkbenchSandboxHandle): Promise<WorkbenchSandboxHandle> {
    const existing = sandboxes.get(session.id);
    if (existing) {
      return {
        provider: "e2b",
        providerSessionId: existing.sandboxId,
        workdir: handle.workdir ?? DEFAULT_WORKDIR,
        previewMode: handle.previewMode,
        providerUrl: handle.providerUrl,
        expiresAt: handle.expiresAt,
      };
    }
    if (!handle.providerSessionId) {
      throw new Error("Cannot restore E2B workbench provider without a providerSessionId");
    }
    const credentials = await resolveWorkbenchProviderCredentialEnv(session.companyId, "e2b");
    const apiKey = credentials.env.E2B_API_KEY;
    if (!apiKey) throw new Error("E2B_API_KEY is required to restore an E2B workbench provider");

    const sb = await Sandbox.connect(handle.providerSessionId, {
      apiKey,
      timeoutMs: DEFAULT_SANDBOX_TIMEOUT_MS,
    });
    sandboxes.set(session.id, sb);

    await store.addWorkbenchEvent({
      companyId: session.companyId,
      sessionId: session.id,
      type: "system",
      status: "completed",
      title: "E2B sandbox restored",
      content: `Sandbox ${sb.sandboxId} restored with ${credentials.source} credentials`,
    });

    return {
      provider: "e2b",
      providerSessionId: sb.sandboxId,
      workdir: handle.workdir ?? DEFAULT_WORKDIR,
      previewMode: handle.previewMode,
      providerUrl: handle.providerUrl,
      expiresAt: handle.expiresAt,
    };
  },

  async stop(session: WorkbenchSession): Promise<void> {
    const sb = sandboxes.get(session.id);
    if (!sb) return;
    sandboxes.delete(session.id);

    // Retry kill with backoff: a transient failure that leaves the sandbox
    // running keeps billing the company. Escalate (audit event) if all attempts
    // fail so a human can reap it manually.
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await sb.kill();
        return;
      } catch (error) {
        lastError = error;
        if (attempt < 3) await delay(250 * attempt);
      }
    }

    console.error("e2b.stop_failed", {
      sessionId: session.id,
      sandboxId: sb.sandboxId,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    });
    await store.addWorkbenchEvent({
      companyId: session.companyId,
      sessionId: session.id,
      type: "system",
      status: "failed",
      title: "E2B sandbox stop failed",
      content: `Failed to kill sandbox ${sb.sandboxId} after 3 attempts — it may still be running and incurring cost. Manual review required.`,
    }).catch(() => { /* best-effort */ });
  },

  async exec(
    session: WorkbenchSession,
    command: string,
    options?: WorkbenchExecOptions
  ): Promise<WorkbenchExecResult> {
    const sb = getSandbox(session.id);
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

    const net = checkNetworkPolicy(command, session.metadata.networkPolicy, session.metadata.allowedHosts);
    if (net.blocked) {
      await store.addWorkbenchEvent({
        companyId: session.companyId,
        sessionId: session.id,
        type: "shell",
        status: "failed",
        title: "Network blocked",
        content: net.reason ?? "Network egress is not allowed for this session.",
        command,
      });
      return {
        stdout: "",
        stderr: net.reason ?? "Network egress blocked by session policy.",
        exitCode: 126,
        durationMs: Date.now() - start,
        blocked: true,
        blockedReason: net.reason,
      };
    }

    await store.addWorkbenchEvent({
      companyId: session.companyId,
      sessionId: session.id,
      type: "shell",
      status: "running",
      title: `$ ${command.slice(0, 80)}`,
      content: "Running command in E2B sandbox...",
      command,
    });

    const result = await runSandboxCommand(sb, command, {
      cwd: options?.cwd ?? DEFAULT_WORKDIR,
      timeoutMs: options?.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
      envs: sanitizeSandboxEnv(options?.env),
    });
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
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
    const sb = getSandbox(session.id);
    // Guard against workdir escape (e.g. "../../etc/passwd" or "/etc/passwd").
    const abs = safePosixPath(DEFAULT_WORKDIR, filePath);
    return sb.files.read(abs);
  },

  async writeFile(session: WorkbenchSession, filePath: string, content: string): Promise<void> {
    const sb = getSandbox(session.id);
    const abs = safePosixPath(DEFAULT_WORKDIR, filePath);
    await sb.files.write(abs, content);
  },

  async listFiles(session: WorkbenchSession, dirPath?: string): Promise<WorkbenchFileEntry[]> {
    const sb = getSandbox(session.id);
    const normalizedDir = dirPath === "." ? undefined : dirPath;
    const abs = normalizedDir ? safePosixPath(DEFAULT_WORKDIR, normalizedDir) : DEFAULT_WORKDIR;

    const entries = await sb.files.list(abs);
    return entries.map((e) => ({
      name: e.name,
      path: normalizeWorkbenchPath(e.path ?? e.name, DEFAULT_WORKDIR),
      isDir: e.type === "dir",
      sizeBytes: 0,
      modifiedAt: nowIso(),
    }));
  },

  async getFileTree(session: WorkbenchSession, options?: WorkbenchFileTreeOptions): Promise<WorkbenchFileEntry[]> {
    return getProviderFileTree(e2bProvider, session, options);
  },

  async diffSinceCheckpoint(session: WorkbenchSession, checkpointHash?: string) {
    return diffProviderFileTree(e2bProvider, session, checkpointHash);
  },

  async snapshot(session: WorkbenchSession) {
    const sb = getSandbox(session.id);
    return snapshotProviderFileTree(e2bProvider, session, sb.sandboxId);
  },

  async exportArtifacts(session: WorkbenchSession) {
    return exportProviderArtifacts(e2bProvider, session);
  },

  async runTests(
    session: WorkbenchSession,
    command?: string
  ): Promise<WorkbenchTestResult> {
    const sb = getSandbox(session.id);
    const start = Date.now();

    let cmd = command;
    if (!cmd) {
      const detected = await detectTestRunner(DEFAULT_WORKDIR);
      cmd = detected.command;
    }

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

    const result = await runSandboxCommand(sb, cmd, {
      cwd: DEFAULT_WORKDIR,
      timeoutMs: DEFAULT_EXEC_TIMEOUT_MS * 5,
    });

    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    const durationMs = Date.now() - start;

    const passed = parseInt(output.match(/(\d+)\s+pass(?:ed)?/i)?.[1] ?? "0", 10);
    const failed = parseInt(output.match(/(\d+)\s+fail(?:ed)?/i)?.[1] ?? "0", 10);
    const skipped = parseInt(output.match(/(\d+)\s+skip(?:ped)?/i)?.[1] ?? "0", 10);

    return { passed, failed, skipped, durationMs, output, exitCode: result.exitCode ?? 0 };
  },

  async screenshot(
    session: WorkbenchSession,
    options?: { url?: string; width?: number; height?: number }
  ): Promise<WorkbenchScreenshotResult> {
    const previewUrl = options?.url ?? (await e2bProvider.getPreviewUrl(session));
    if (!previewUrl) {
      return { dataUri: "", width: 0, height: 0, storageKey: "" };
    }
    const storageKey = `e2b/${session.id}/screenshot`;
    return captureScreenshot(previewUrl, {
      width: options?.width,
      height: options?.height,
      storageKey,
      sessionId: session.id,
    });
  },

  async getPreviewUrl(session: WorkbenchSession): Promise<string | undefined> {
    const sb = sandboxes.get(session.id);
    if (!sb) return undefined;

    const ports = [3000, 5173, 4200, 8080, 4000, 8000];
    for (const port of ports) {
      try {
        const host = sb.getHost(port);
        return `https://${host}`;
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
    const sb = getSandbox(session.id);
    const start = Date.now();
    // Resolve the listen port in priority order:
    //   1. explicit portHint from the caller
    //   2. a --port flag inside the command (e.g. "vite --port 3000")
    //   3. a PORT=NNNN prefix in the command
    //   4. default 3000 (matches the starter template's vite config)
    // The previous default of 5173 (Vite's built-in default) was wrong: the
    // starter binds Vite to 3000, so the wait loop never saw 5173 listening.
    const port = portHint ?? parsePortFromCommand(command) ?? DEFAULT_PREVIEW_PORT;

    const blocked = await blockedPreviewCommand(session, command, start);
    if (blocked) return { command, port, result: blocked };

    // Kill any dev server left over from a previous repair cycle that is still
    // bound to this port. Without this, the new `npm run dev` either fails with
    // EADDRINUSE or Vite silently increments to 3001 — and the wait loop then
    // observes the *stale* process on 3000, serving outdated code. Free the port
    // first so the new process binds cleanly and we verify the latest build.
    await sb.commands.run(
      `sh -c 'fuser -k ${port}/tcp 2>/dev/null || true; ` +
      `for pid in $(ss -tlnpH 2>/dev/null | grep ":${port} " | grep -oE "pid=[0-9]+" | cut -d= -f2); do kill -9 "$pid" 2>/dev/null || true; done; true'`,
      { timeoutMs: 5_000 },
    ).catch(() => { /* best-effort cleanup */ });

    // Use E2B's native background mode. The nohup-in-subshell approach kills
    // the child when the parent shell exits, so the dev server never stays up.
    await sb.commands.run(command, {
      cwd: DEFAULT_WORKDIR,
      background: true,
      envs: sanitizeSandboxEnv({ PORT: String(port) }),
    });
    const url = await waitForE2bPreviewHost(sb, port);

    await store.addWorkbenchEvent({
      companyId: session.companyId,
      sessionId: session.id,
      type: "deploy",
      status: "completed",
      title: "E2B preview started",
      content: url,
      command,
    });

    return {
      command,
      url,
      port,
      result: {
        stdout: "",
        stderr: "",
        exitCode: 0,
        durationMs: Date.now() - start,
      },
    };
  },

  async inspectPreview(session: WorkbenchSession, url: string): Promise<WorkbenchPreviewInspection> {
    const sb = getSandbox(session.id);
    const screenshot = await this.screenshot(session, { url });
    return inspectHttpPreview(url, screenshot, { trafficAccessToken: sb?.trafficAccessToken });
  },

  async captureArtifact(
    session: WorkbenchSession,
    input: WorkbenchCaptureArtifactInput
  ): Promise<{ artifact: WorkbenchArtifact; event: WorkbenchEvent }> {
    const sizeBytes = input.sizeBytes ?? Buffer.byteLength(input.content ?? "", "utf8");
    const storageKey = `e2b/${session.id}/${makeId("artifact")}`;

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

registerWorkbenchProvider(e2bProvider);

export { e2bProvider };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeSandboxEnv(env?: Record<string, string>) {
  if (!env) return undefined;
  return redactSecretEnv(env);
}

async function runSandboxCommand(
  sandbox: Sandbox,
  command: string,
  options: Parameters<Sandbox["commands"]["run"]>[1],
): Promise<E2BCommandResult> {
  try {
    return await sandbox.commands.run(command, options);
  } catch (error) {
    const result = extractCommandResult(error);
    if (result) return result;
    throw error;
  }
}

function extractCommandResult(error: unknown): E2BCommandResult | undefined {
  if (!error || typeof error !== "object" || !("result" in error)) return undefined;
  const result = (error as { result?: unknown }).result;
  if (!result || typeof result !== "object") return undefined;
  const candidate = result as Record<string, unknown>;
  return {
    stdout: typeof candidate.stdout === "string" ? candidate.stdout : "",
    stderr: typeof candidate.stderr === "string" ? candidate.stderr : "",
    exitCode: typeof candidate.exitCode === "number" ? candidate.exitCode : 1,
  };
}

async function waitForE2bPreviewHost(sb: Sandbox, port: number, deadlineMs = 90_000): Promise<string> {
  const url = `https://${sb.getHost(port)}`;
  const deadline = Date.now() + deadlineMs;
  // Verify the port is actually listening inside the sandbox before returning.
  // E2B's external proxy returns 403 until something binds the port; checking
  // from inside is more reliable and avoids the 60-second HTTP poll delay.
  while (Date.now() < deadline) {
    try {
      const result = await sb.commands.run(`sh -c 'ss -tlnp 2>/dev/null | grep -q ":${port} " && echo ok || exit 1'`, {
        timeoutMs: 5_000,
      });
      if ((result.exitCode ?? 1) === 0) return url;
    } catch {
      // ss not available or other transient error — fall through and retry
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`E2B preview port ${port} was not listening within ${deadlineMs}ms`);
}
