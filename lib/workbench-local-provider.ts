/**
 * mock_local Workbench Provider
 *
 * Runs commands in an isolated per-session temp directory on the host.
 * - Enforces a strict shell command allowlist
 * - Prevents path traversal for file operations
 * - Emits WorkbenchEvent + WorkbenchArtifact for every action
 * - External writes (git push, deploy, form submit, etc.) emit `needs_approval` events
 *
 * This provider is used in development/tests and as the safe default.
 * E2B / Daytona are added as separate providers by registering them in workbench-provider.ts.
 */

import { execFile, spawn, type ChildProcess } from "child_process";
import { promisify } from "util";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { createHash } from "crypto";
import { store } from "@/lib/store";
import { makeId, nowIso } from "@/lib/utils";
import {
  registerWorkbenchProvider,
  type WorkbenchCaptureArtifactInput,
  type WorkbenchExecOptions,
  type WorkbenchExecResult,
  type WorkbenchExportResult,
  type WorkbenchFileEntry,
  type WorkbenchFileTreeOptions,
  type WorkbenchPreviewInspection,
  type WorkbenchPreviewRun,
  type WorkbenchProviderAdapter,
  type WorkbenchSandboxHandle,
  type WorkbenchSandboxSnapshot,
  type WorkbenchScreenshotResult,
  type WorkbenchTestResult,
} from "@/lib/workbench-provider";
import type { WorkbenchArtifact, WorkbenchEvent, WorkbenchSession } from "@/lib/types";
import { checkCommand, requiresApproval, safePath, checkNetworkPolicy, redactSecretEnv } from "@/lib/workbench-safety";
import { recordSessionSpend } from "@/lib/workbench-orchestrator";
import {
  syncWorkspace,
  createSessionWorktree,
  removeSessionWorktree,
  sessionWorktreeDir,
  ensureDeps,
} from "@/lib/workbench-workspace";
import { captureScreenshot } from "@/lib/workbench-screenshot";
import { getLocalPreviewUrl, isHostAppPreviewUrl, probePort } from "@/lib/workbench-preview";
import {
  PREVIEW_PID_FILENAME,
  reapOrphanedPreview,
  type PreviewPidRecord,
} from "@/lib/workbench-preview-reaper";

const execFileAsync = promisify(execFile);

// ── Storage root ──────────────────────────────────────────────────────────────

const WORKBENCH_ROOT = process.env.WORKBENCH_STORAGE_ROOT ?? path.join(os.tmpdir(), "trent-workbench");

async function sessionWorkdir(session: WorkbenchSession): Promise<string> {
  // If a workspace worktree exists for this session, use it
  if (session.repoUrl) {
    const wtDir = sessionWorktreeDir(session.companyId, session.id);
    try {
      await fs.access(wtDir);
      return wtDir;
    } catch {
      // fall through to default
    }
  }
  const dir = path.join(WORKBENCH_ROOT, "sessions", session.id);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function sanitizedSandboxEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  // Strip EVERY secret-shaped host env var (not just a hardcoded handful) so the
  // sandbox shell can never read the platform's real credentials. Without this,
  // `execFile` passes the host's full process.env into the sandbox. Operational
  // vars (PATH, HOME, NODE_ENV, npm_config_*) are preserved so builds still run.
  const env = redactSecretEnv({
    ...process.env,
    ...extra,
    NODE_ENV: "development",
    npm_config_include: "dev",
  }) as NodeJS.ProcessEnv;

  if (extra?.PORT) env.PORT = extra.PORT;
  else delete env.PORT;

  delete env.NPM_CONFIG_PRODUCTION;
  delete env.npm_config_production;
  delete env.NPM_CONFIG_OMIT;
  delete env.npm_config_omit;

  return env;
}

function isLongRunningPreviewCommand(command: string): boolean {
  const normalized = command.trim().replace(/\s+/g, " ");
  return /^(npm|pnpm|yarn) (start|run (dev|start|preview))($| )/.test(normalized)
    || /^npx (vite|next|astro|webpack-dev-server)($| )/.test(normalized)
    || /^(vite|next dev|astro dev|webpack-dev-server)($| )/.test(normalized);
}

type BackgroundProcess = {
  child: ChildProcess;
  port: number;
  /** URL path prefix the dev server serves under (vite --base), if any. */
  basePath?: string;
};

function trackedPreviewUrl(port: number, basePath?: string): string {
  return `http://localhost:${port}${basePath ?? ""}`;
}

function previewPidFile(sessionDir: string): string {
  return path.join(sessionDir, PREVIEW_PID_FILENAME);
}

/**
 * Persist the background preview PID + port to a JSON sidecar in the session
 * workdir so the process can be reaped after a server/container restart that
 * clears the in-memory tracking map. Best-effort: never throws.
 */
async function writePreviewSidecar(sessionDir: string, pid: number | undefined, port: number): Promise<void> {
  if (!pid) return;
  const record: PreviewPidRecord = { pid, port, startedAt: nowIso() };
  try {
    await fs.writeFile(previewPidFile(sessionDir), JSON.stringify(record), "utf8");
  } catch {
    // Best-effort: a missing sidecar only means we can't reap across a restart.
  }
}

/** Remove the preview sidecar on a clean stop. Best-effort: never throws. */
async function removePreviewSidecar(sessionDir: string): Promise<void> {
  try {
    await fs.rm(previewPidFile(sessionDir), { force: true });
  } catch {
    // Best-effort.
  }
}

/**
 * Before starting a NEW background preview, kill any stale process still
 * recorded in the sidecar (e.g. a leaked dev server from before a restart) so it
 * doesn't hold the port (EADDRINUSE) or serve stale content. Best-effort.
 */
async function reapStalePreview(sessionDir: string): Promise<void> {
  try {
    await reapOrphanedPreview(sessionDir, { maxAgeMs: 0 });
  } catch {
    // Best-effort: never block a fresh preview on a failed reap.
  }
}

function stopBackgroundProcess(sessionId: string): void {
  const existing = backgroundProcesses.get(sessionId);
  if (!existing) return;
  killProcessTree(existing.child);
  backgroundProcesses.delete(sessionId);
  backgroundPreviewPorts.delete(sessionId);
}

function killProcessTree(child: ChildProcess): void {
  if (!child.pid) {
    child.kill();
    return;
  }

  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }).unref();
      return;
    } catch {
      // Fall back to killing only the parent process.
    }
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
      setTimeout(() => {
        try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ }
      }, 750).unref();
      return;
    } catch {
      // Fall back to killing only the parent process.
    }
  }

  try { child.kill("SIGTERM"); } catch { /* already gone */ }
}

const WINDOWS_CMD_LAUNCHERS = new Set(["npm", "npx", "pnpm", "yarn", "bun", "corepack"]);

function windowsShellNeeded(executable: string): boolean {
  return process.platform === "win32" && WINDOWS_CMD_LAUNCHERS.has(executable.toLowerCase());
}

function quoteForWindowsShell(args: string[]): string[] {
  return args.map((arg) =>
    /[\s&|<>^()%!]/.test(arg) ? `"${arg.replaceAll('"', "")}"` : arg,
  );
}

const CHECKPOINT_IGNORE_RE = /(^|[\\/])(node_modules|\.git|\.next|dist|build|coverage|tmp|\.cache)([\\/]|$)/;

async function checkpointIncludes(root: string, src: string): Promise<boolean> {
  const rel = path.relative(root, src);
  if (!rel) return true;
  if (CHECKPOINT_IGNORE_RE.test(rel)) return false;
  try {
    return !(await fs.lstat(src)).isSymbolicLink();
  } catch {
    return false;
  }
}

async function listCheckpointFiles(dir: string, root: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full);
    if (CHECKPOINT_IGNORE_RE.test(rel)) continue;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) out.push(...await listCheckpointFiles(full, root));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

async function previewCommandArgs(
  command: string,
  executable: string,
  args: string[],
  cwd: string,
  port: number,
  previewBase?: string,
): Promise<{ spawnArgs: string[]; basePath?: string }> {
  const normalized = command.trim().replace(/\s+/g, " ");
  const scriptName = args[0] === "start" ? "start" : args[1] ?? "dev";
  const script = await readPackageScript(cwd, scriptName);
  const commandText = `${normalized} ${script ?? ""}`.toLowerCase();

  if (commandText.includes("vite")) {
    // --base makes every URL vite emits (HTML assets AND absolute imports
    // inside served JS modules like "/src/globals.css" or
    // "/node_modules/.vite/deps/react.js") proxy-shaped. Without it, the
    // host-app preview proxy at /api/workbench/{id}/preview/ can only rewrite
    // the HTML — nested module imports resolve against the host domain root,
    // 404 on the Next.js app, and the user sees a white screen even though
    // in-container verification (direct localhost) passes.
    const baseArgs = previewBase ? ["--base", previewBase] : [];
    return {
      spawnArgs: appendNpmRunArgs(executable, args, ["--host", "127.0.0.1", "--port", String(port), ...baseArgs]),
      basePath: previewBase,
    };
  }
  if (commandText.includes("next")) {
    return { spawnArgs: appendNpmRunArgs(executable, args, ["--hostname", "127.0.0.1", "--port", String(port)]) };
  }
  if (commandText.includes("astro")) {
    return { spawnArgs: appendNpmRunArgs(executable, args, ["--host", "127.0.0.1", "--port", String(port)]) };
  }
  if (commandText.includes("webpack-dev-server")) {
    return { spawnArgs: appendNpmRunArgs(executable, args, ["--host", "127.0.0.1", "--port", String(port)]) };
  }
  return { spawnArgs: args };
}

function appendNpmRunArgs(executable: string, args: string[], previewArgs: string[]): string[] {
  const isPackageRun = ["npm", "pnpm", "yarn", "bun"].includes(executable)
    && (args[0] === "run" || args[0] === "start");
  return isPackageRun ? [...args, "--", ...previewArgs] : [...args, ...previewArgs];
}

async function readPackageScript(cwd: string, scriptName: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(path.join(cwd, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    return pkg.scripts?.[scriptName];
  } catch {
    return undefined;
  }
}

async function startBackgroundCommand(
  session: WorkbenchSession,
  command: string,
  executable: string,
  args: string[],
  cwd: string,
  start: number,
  env?: Record<string, string>,
): Promise<WorkbenchExecResult> {
  stopBackgroundProcess(session.id);
  const sidecarDir = await sessionWorkdir(session);
  // Kill any leaked preview still recorded from a previous run (prevents EADDRINUSE).
  await reapStalePreview(sidecarDir);
  const previewPort = await findPreviewPort();
  const previewBase = `/api/workbench/${session.id}/preview/`;
  const { spawnArgs, basePath } = await previewCommandArgs(command, executable, args, cwd, previewPort, previewBase);

  const useShell = windowsShellNeeded(executable);
  const child = spawn(executable, useShell ? quoteForWindowsShell(spawnArgs) : spawnArgs, {
    cwd,
    env: sanitizedSandboxEnv({
      ...env,
      PORT: String(previewPort),
      VITE_PORT: String(previewPort),
      HOST: "127.0.0.1",
    }),
    detached: process.platform !== "win32",
    shell: useShell,
    stdio: ["ignore", "pipe", "pipe"],
  });
  backgroundProcesses.set(session.id, { child, port: previewPort, basePath });
  backgroundPreviewPorts.set(session.id, previewPort);
  await writePreviewSidecar(sidecarDir, child.pid, previewPort);

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const earlyExit = new Promise<number | undefined>((resolve) => {
    child.once("exit", (code) => resolve(code ?? 1));
    setTimeout(() => resolve(undefined), BACKGROUND_STARTUP_MS);
  });
  const exitCode = await earlyExit;
  const durationMs = Date.now() - start;

  if (typeof exitCode === "number") {
    if (backgroundProcesses.get(session.id)?.child === child) {
      backgroundProcesses.delete(session.id);
      backgroundPreviewPorts.delete(session.id);
    }
    await removePreviewSidecar(sidecarDir);
    await store.addWorkbenchEvent({
      companyId: session.companyId,
      sessionId: session.id,
      type: "shell",
      status: "failed",
      title: `$ ${command.slice(0, 80)}`,
      content: [
        stdout.slice(0, 2000),
        stderr ? `[stderr] ${stderr.slice(0, 500)}` : "",
      ].filter(Boolean).join("\n") || `Dev server exited with code ${exitCode}`,
      command,
    });
    await recordSessionSpend(session.id, 0);
    return { stdout, stderr, exitCode, durationMs };
  }

  let previewUrl: string | undefined;
  for (let i = 0; i < 20; i++) {
    if (await probePort(previewPort, 250)) {
      previewUrl = trackedPreviewUrl(previewPort, basePath);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const message = previewUrl
    ? `Started background preview server at ${previewUrl}`
    : "Started background preview server; preview port is still warming up.";
  if (previewUrl) {
    await store.updateWorkbenchSession(session.id, { previewUrl }).catch(() => {});
  }
  await store.addWorkbenchEvent({
    companyId: session.companyId,
    sessionId: session.id,
    type: "shell",
    status: "completed",
    title: `$ ${command.slice(0, 80)}`,
    content: [message, stdout.slice(0, 1200), stderr ? `[stderr] ${stderr.slice(0, 300)}` : ""].filter(Boolean).join("\n"),
    command,
  });
  await recordSessionSpend(session.id, 0);
  return { stdout: message, stderr, exitCode: 0, durationMs };
}

async function startBestEffortPreviewServer(
  session: WorkbenchSession,
  workdir: string,
): Promise<string | undefined> {
  // Sidecar lives in the session root even if we serve a /public subdir below.
  const sidecarDir = await sessionWorkdir(session);
  try {
    await fs.access(path.join(workdir, "index.html"));
  } catch {
    try {
      await fs.access(path.join(workdir, "public", "index.html"));
      workdir = path.join(workdir, "public");
    } catch {
      return undefined;
    }
  }

  stopBackgroundProcess(session.id);
  await reapStalePreview(sidecarDir);
  const port = await findPreviewPort();
  const serverScript = [
    "const http=require('http'),fs=require('fs'),path=require('path');",
    "const root=process.cwd();",
    "const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg'};",
    "http.createServer((req,res)=>{",
    "const raw=decodeURIComponent((req.url||'/').split('?')[0]);",
    "const rel=raw==='/'?'index.html':raw.replace(/^\\/+/, '');",
    "const file=path.normalize(path.join(root,rel));",
    "if(!file.startsWith(root)){res.writeHead(403);res.end('Forbidden');return;}",
    "fs.readFile(file,(err,data)=>{",
    "if(err){res.writeHead(404);res.end('Not found');return;}",
    "res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream'});res.end(data);",
    "});",
    "}).listen(Number(process.env.PORT),'127.0.0.1');",
  ].join("");
  const child = spawn("node", ["-e", serverScript], {
    cwd: workdir,
    env: sanitizedSandboxEnv({ PORT: String(port) }),
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  backgroundProcesses.set(session.id, { child, port });
  backgroundPreviewPorts.set(session.id, port);
  await writePreviewSidecar(sidecarDir, child.pid, port);

  for (let i = 0; i < 10; i++) {
    if (await probePort(port, 250)) {
      const url = `http://localhost:${port}`;
      await store.addWorkbenchEvent({
        companyId: session.companyId,
        sessionId: session.id,
        type: "deploy",
        status: "completed",
        title: "Preview server started",
        content: url,
      });
      return url;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  stopBackgroundProcess(session.id);
  await removePreviewSidecar(sidecarDir);
  return undefined;
}

async function findPreviewPort(): Promise<number> {
  for (let port = 4100; port < 4200; port++) {
    if (!(await probePort(port, 100))) return port;
  }
  return 4199;
}

// ── Provider implementation ───────────────────────────────────────────────────

const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
const BACKGROUND_STARTUP_MS = 3_000;
const backgroundProcesses = new Map<string, BackgroundProcess>();
const backgroundPreviewPorts = new Map<string, number>();

const localProvider: WorkbenchProviderAdapter = {
  name: "mock_local",

  async start(session: WorkbenchSession): Promise<WorkbenchSandboxHandle> {
    let workdir: string;
    let content: string;

    if (session.repoUrl) {
      try {
        const { workdir: wsDir } = await syncWorkspace(
          session.companyId,
          session.repoUrl,
          session.branchName
        );
        workdir = await createSessionWorktree(session.companyId, session.id, session.branchName);
        await ensureDeps(workdir);
        content = `Persistent workspace ready at ${wsDir}; session worktree: ${workdir}`;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        content = `mock_local: workspace sync failed (${msg}) — using empty workdir`;
        workdir = path.join(WORKBENCH_ROOT, "sessions", session.id);
        await fs.mkdir(workdir, { recursive: true });
      }
    } else {
      workdir = path.join(WORKBENCH_ROOT, "sessions", session.id);
      await fs.mkdir(workdir, { recursive: true });
      await fs.writeFile(
        path.join(workdir, "README.md"),
        `# Trent Workbench Session\n\nSession ID: ${session.id}\nObjective: ${session.objective}\nStarted: ${nowIso()}\n`
      );
      content = `mock_local sandbox ready at ${workdir}`;
    }

    await store.addWorkbenchEvent({
      companyId: session.companyId,
      sessionId: session.id,
      type: "system",
      status: "completed",
      title: "Workbench provisioned",
      content
    });

    return {
      provider: "mock_local",
      providerSessionId: session.id,
      workdir,
      previewMode: "local_port",
      expiresAt: new Date(Date.now() + session.metadata.maxRuntimeSeconds * 1000).toISOString(),
    };
  },

  async restore(session: WorkbenchSession, handle: WorkbenchSandboxHandle): Promise<WorkbenchSandboxHandle> {
    const workdir = handle.workdir ?? await sessionWorkdir(session);
    await fs.mkdir(workdir, { recursive: true });
    return {
      ...handle,
      provider: "mock_local",
      providerSessionId: handle.providerSessionId ?? session.id,
      workdir,
      previewMode: handle.previewMode ?? "local_port",
    };
  },

  async stop(session: WorkbenchSession): Promise<void> {
    stopBackgroundProcess(session.id);
    await removePreviewSidecar(await sessionWorkdir(session).catch(() => "")).catch(() => {});
    if (session.repoUrl) {
      await removeSessionWorktree(session.companyId, session.id).catch(() => { /* best effort */ });
    }
    await store.addWorkbenchEvent({
      companyId: session.companyId,
      sessionId: session.id,
      type: "system",
      status: "completed",
      title: "Workbench stopped",
      content: "Session workspace preserved for replay. Files remain until manually cleaned."
    });
  },

  async exec(
    session: WorkbenchSession,
    command: string,
    options?: WorkbenchExecOptions
  ): Promise<WorkbenchExecResult> {
    const start = Date.now();

    // Approval gate for external writes
    if (requiresApproval(command)) {
      await store.addWorkbenchEvent({
        companyId: session.companyId,
        sessionId: session.id,
        type: "shell",
        status: "needs_approval",
        title: "Approval required",
        content: `Command requires approval before execution: \`${command}\``,
        command
      });
      return {
        stdout: "",
        stderr: "Approval required before executing this command.",
        exitCode: 1,
        durationMs: Date.now() - start,
        blocked: true,
        blockedReason: "external_write_requires_approval"
      };
    }

    // Allowlist check
    const check = checkCommand(command);
    if (check.blocked) {
      await store.addWorkbenchEvent({
        companyId: session.companyId,
        sessionId: session.id,
        type: "shell",
        status: "failed",
        title: "Command blocked",
        content: check.reason ?? "Command is not allowed.",
        command
      });
      return {
        stdout: "",
        stderr: check.reason ?? "Command blocked by safety policy.",
        exitCode: 126,
        durationMs: Date.now() - start,
        blocked: true,
        blockedReason: check.reason
      };
    }

    // Network egress policy (curl/wget to non-loopback hosts)
    const net = checkNetworkPolicy(command, session.metadata.networkPolicy, session.metadata.allowedHosts);
    if (net.blocked) {
      await store.addWorkbenchEvent({
        companyId: session.companyId,
        sessionId: session.id,
        type: "shell",
        status: "failed",
        title: "Network blocked",
        content: net.reason ?? "Network egress is not allowed for this session.",
        command
      });
      return {
        stdout: "",
        stderr: net.reason ?? "Network egress blocked by session policy.",
        exitCode: 126,
        durationMs: Date.now() - start,
        blocked: true,
        blockedReason: net.reason
      };
    }

    const workdir = await sessionWorkdir(session);
    const cwd = options?.cwd ? safePath(workdir, options.cwd) : workdir;
    const timeoutMs = options?.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;

    // Log start
    await store.addWorkbenchEvent({
      companyId: session.companyId,
      sessionId: session.id,
      type: "shell",
      status: "running",
      title: `$ ${command.slice(0, 80)}`,
      content: "Running command...",
      command
    });

    let stdout = "";
    let stderr = "";
    let exitCode = 0;

    try {
      const parts = command.trim().split(/\s+/);
      const executable = parts[0]!;
      const args = parts.slice(1);
      if (isLongRunningPreviewCommand(command)) {
        return await startBackgroundCommand(session, command, executable, args, cwd, start, options?.env);
      }
      const useShell = windowsShellNeeded(executable);
      const result = await execFileAsync(executable, useShell ? quoteForWindowsShell(args) : args, {
        cwd,
        timeout: timeoutMs,
        env: sanitizedSandboxEnv(options?.env),
        maxBuffer: 4 * 1024 * 1024, // 4MB
        shell: useShell,
      });
      stdout = result.stdout ?? "";
      stderr = result.stderr ?? "";
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; code?: number; signal?: string };
      stdout = e.stdout ?? "";
      stderr = e.stderr ?? String(err);
      exitCode = typeof e.code === "number" ? e.code : 1;
    }

    const durationMs = Date.now() - start;

    // Log completion
    await store.addWorkbenchEvent({
      companyId: session.companyId,
      sessionId: session.id,
      type: "shell",
      status: exitCode === 0 ? "completed" : "failed",
      title: `$ ${command.slice(0, 80)}`,
      content: [
        stdout.slice(0, 2000),
        stderr ? `[stderr] ${stderr.slice(0, 500)}` : ""
      ].filter(Boolean).join("\n") || "(no output)",
      command
    });

    // Record session spend (0 cost for mock_local provider)
    await recordSessionSpend(session.id, 0);

    return { stdout, stderr, exitCode, durationMs };
  },

  async readFile(session: WorkbenchSession, filePath: string): Promise<string> {
    const workdir = await sessionWorkdir(session);
    const safe = safePath(workdir, filePath);
    const content = await fs.readFile(safe, "utf-8");

    await store.addWorkbenchEvent({
      companyId: session.companyId,
      sessionId: session.id,
      type: "file",
      status: "completed",
      title: `Read file: ${filePath}`,
      content: content.slice(0, 500) + (content.length > 500 ? "\n…(truncated)" : "")
    });

    return content;
  },

  async writeFile(session: WorkbenchSession, filePath: string, content: string): Promise<void> {
    const workdir = await sessionWorkdir(session);
    const safe = safePath(workdir, filePath);
    await fs.mkdir(path.dirname(safe), { recursive: true });
    await fs.writeFile(safe, content, "utf-8");

    await store.addWorkbenchEvent({
      companyId: session.companyId,
      sessionId: session.id,
      type: "file",
      status: "completed",
      title: `Wrote file: ${filePath}`,
      content: `${content.length} bytes written to ${filePath}`
    });
  },

  async listFiles(session: WorkbenchSession, dirPath?: string): Promise<WorkbenchFileEntry[]> {
    const workdir = await sessionWorkdir(session);
    const target = dirPath ? safePath(workdir, dirPath) : workdir;

    let entries: import("fs").Dirent[] = [];
    try {
      entries = await fs.readdir(target, { withFileTypes: true });
    } catch {
      return [];
    }

    const results: WorkbenchFileEntry[] = [];
    for (const entry of entries) {
      const full = path.join(target, entry.name);
      let sizeBytes = 0;
      let modifiedAt = nowIso();
      try {
        const stat = await fs.stat(full);
        sizeBytes = stat.size;
        modifiedAt = stat.mtime.toISOString();
      } catch { /* ignore stat errors */ }

      results.push({
        name: entry.name,
        path: path.relative(workdir, full),
        isDir: entry.isDirectory(),
        sizeBytes,
        modifiedAt
      });
    }

    return results;
  },

  async runTests(session: WorkbenchSession, command?: string): Promise<WorkbenchTestResult> {
    const workdirForDetect = await sessionWorkdir(session);
    const { detectTestRunner } = await import("@/lib/test-runner");
    const detected = await detectTestRunner(workdirForDetect);
    const testCommand = command ?? detected.command;
    const start = Date.now();

    if (!testCommand) {
      const output = "No test runner detected; skipped.";
      const durationMs = Date.now() - start;
      const testResult: WorkbenchTestResult = {
        passed: 0,
        failed: 0,
        skipped: 1,
        durationMs,
        output,
        exitCode: 0,
      };
      await store.addWorkbenchEvent({
        companyId: session.companyId,
        sessionId: session.id,
        type: "test",
        status: "completed",
        title: "Tests skipped",
        content: output,
      });
      return testResult;
    }

    const execResult = await this.exec(session, testCommand, { timeoutMs: 120_000 });
    const durationMs = Date.now() - start;

    // Simple parser: look for "X passing" / "X failing" / "X pending" patterns (mocha/jest/vitest)
    const output = execResult.stdout + execResult.stderr;
    const passedMatch = output.match(/(\d+)\s+(passing|passed|tests? passed)/i);
    const failedMatch = output.match(/(\d+)\s+(failing|failed|tests? failed)/i);
    const skippedMatch = output.match(/(\d+)\s+(pending|skipped)/i);

    const testResult: WorkbenchTestResult = {
      passed: passedMatch ? parseInt(passedMatch[1], 10) : (execResult.exitCode === 0 ? 1 : 0),
      failed: failedMatch ? parseInt(failedMatch[1], 10) : (execResult.exitCode !== 0 ? 1 : 0),
      skipped: skippedMatch ? parseInt(skippedMatch[1], 10) : 0,
      durationMs,
      output: output.slice(0, 8000),
      exitCode: execResult.exitCode
    };

    // Capture as artifact
    const workdir = await sessionWorkdir(session);
    const storageKey = `workbench/${session.id}/test-result-${makeId("tr")}.txt`;
    const artifactPath = path.join(workdir, path.basename(storageKey));
    await fs.writeFile(artifactPath, output).catch(() => { /* best effort */ });

    const artifact = await store.addWorkbenchArtifact({
      companyId: session.companyId,
      sessionId: session.id,
      kind: "test_result",
      title: `Test result: ${testCommand}`,
      storageKey,
      mimeType: "text/plain",
      sizeBytes: output.length,
      createdByAgent: session.agentRole,
      path: path.basename(storageKey),
      metadata: { command: testCommand }
    });

    await store.addWorkbenchEvent({
      companyId: session.companyId,
      sessionId: session.id,
      type: "test",
      status: testResult.failed > 0 ? "failed" : "completed",
      title: `Tests: ${testResult.passed} passed, ${testResult.failed} failed`,
      content: output.slice(0, 1000),
      command: testCommand,
      artifactId: artifact.id
    });

    return testResult;
  },

  async screenshot(
    session: WorkbenchSession,
    options?: { url?: string; width?: number; height?: number }
  ): Promise<WorkbenchScreenshotResult> {
    const workdir = await sessionWorkdir(session);
    const tracked = backgroundProcesses.get(session.id);
    const trackedUrl = tracked && await probePort(tracked.port, 250)
      ? trackedPreviewUrl(tracked.port, tracked.basePath)
      : undefined;
    const localUrl = trackedUrl ?? await getLocalPreviewUrl(workdir);
    const sessionUrl = session.previewUrl && !isHostAppPreviewUrl(session.previewUrl) ? session.previewUrl : undefined;
    const requestedUrl = options?.url && !isHostAppPreviewUrl(options.url) ? options.url : undefined;
    const url = requestedUrl ?? localUrl ?? sessionUrl ?? "http://localhost:3000";
    const width = options?.width ?? 1280;
    const height = options?.height ?? 800;
    const storageKey = `workbench/${session.id}/screenshot-${makeId("ss")}.png`;

    const result = await captureScreenshot(url, { width, height, storageKey, sessionId: session.id });

    const isReal = result.dataUri.startsWith("data:image/png");
    const mimeType = isReal ? "image/png" : "image/svg+xml";

    const artifact = await store.addWorkbenchArtifact({
      companyId: session.companyId,
      sessionId: session.id,
      kind: "screenshot",
      title: `Screenshot: ${url}`,
      storageKey,
      mimeType,
      sizeBytes: result.dataUri.length,
      createdByAgent: session.agentRole,
      previewUrl: url,
      metadata: { width, height, realScreenshot: isReal }
    });

    await store.addWorkbenchEvent({
      companyId: session.companyId,
      sessionId: session.id,
      type: "screenshot",
      status: "completed",
      title: `Screenshot captured: ${url}`,
      content: `${width}×${height} ${isReal ? "Playwright" : "placeholder"} screenshot`,
      artifactId: artifact.id
    });

    return result;
  },

  async getPreviewUrl(session: WorkbenchSession): Promise<string | undefined> {
    const workdir = await sessionWorkdir(session);
    const tracked = backgroundProcesses.get(session.id);
    if (tracked && await probePort(tracked.port, 250)) {
      return trackedPreviewUrl(tracked.port, tracked.basePath);
    }
    const localUrl = await getLocalPreviewUrl(workdir);
    if (localUrl) return localUrl;
    if (session.previewUrl && !isHostAppPreviewUrl(session.previewUrl)) return session.previewUrl;
    return startBestEffortPreviewServer(session, workdir);
  },

  async startPreview(session: WorkbenchSession, command: string, portHint?: number): Promise<WorkbenchPreviewRun> {
    const result = await this.exec(session, command, portHint ? { env: { PORT: String(portHint) } } : undefined);
    const url = await this.getPreviewUrl(session);
    return {
      command,
      url,
      port: url ? Number(new URL(url).port) : undefined,
      result,
    };
  },

  async getFileTree(session: WorkbenchSession, options?: WorkbenchFileTreeOptions): Promise<WorkbenchFileEntry[]> {
    const workdir = await sessionWorkdir(session);
    return listFilesRecursive(workdir, workdir, {
      depth: options?.depth ?? 4,
      includeIgnored: options?.includeIgnored ?? false,
    });
  },

  async diffSinceCheckpoint(session: WorkbenchSession, checkpointHash?: string) {
    const files = await localProvider.getFileTree!(session, { depth: 8 });
    const toHash = hashFileTree(files);
    const changedPaths = checkpointHash === toHash ? [] : files.filter((file) => !file.isDir).map((file) => file.path);
    return {
      changedPaths,
      summary: changedPaths.length
        ? `${changedPaths.length} files differ from checkpoint`
        : "No file tree changes since checkpoint",
      fromHash: checkpointHash,
      toHash,
    };
  },

  async snapshot(session: WorkbenchSession): Promise<WorkbenchSandboxSnapshot> {
    const files = await localProvider.getFileTree!(session, { depth: 8 });
    return {
      id: makeId("wbsnap"),
      fileTreeHash: hashFileTree(files),
      createdAt: nowIso(),
      metadata: {
        fileCount: files.filter((file) => !file.isDir).length,
        providerSessionId: session.id,
      },
    };
  },

  async captureWorkspaceCheckpoint(
    session: WorkbenchSession,
    options?: { replace?: boolean },
  ): Promise<{ id: string }> {
    const workdir = await sessionWorkdir(session);
    const sessionCheckpointRoot = path.join(WORKBENCH_ROOT, "checkpoints", session.id);
    if (options?.replace !== false) {
      await fs.rm(sessionCheckpointRoot, { recursive: true, force: true });
    }
    const id = makeId("wcp");
    await fs.cp(workdir, path.join(sessionCheckpointRoot, id), {
      recursive: true,
      filter: (src) => checkpointIncludes(workdir, src),
    });
    return { id };
  },

  async restoreWorkspaceCheckpoint(
    session: WorkbenchSession,
    checkpointId: string,
  ): Promise<{ restored: boolean; detail?: string }> {
    const workdir = await sessionWorkdir(session);
    const checkpointDir = path.join(WORKBENCH_ROOT, "checkpoints", session.id, checkpointId);
    try {
      const stat = await fs.stat(checkpointDir);
      if (!stat.isDirectory()) return { restored: false, detail: "checkpoint is not a directory" };
    } catch {
      return { restored: false, detail: `checkpoint ${checkpointId} not found` };
    }

    const checkpointFiles = await listCheckpointFiles(checkpointDir, checkpointDir);
    const currentFiles = await listCheckpointFiles(workdir, workdir);
    const keep = new Set(checkpointFiles);
    for (const rel of currentFiles) {
      if (keep.has(rel)) continue;
      await fs.rm(path.join(workdir, rel), { force: true }).catch(() => {});
    }
    await fs.cp(checkpointDir, workdir, { recursive: true, force: true });
    return { restored: true };
  },

  async exportArtifacts(session: WorkbenchSession): Promise<WorkbenchExportResult> {
    const files = await localProvider.getFileTree!(session, { depth: 8 });
    return localProvider.captureArtifact(session, {
      title: "Workbench artifact manifest",
      kind: "export",
      mimeType: "text/markdown",
      content: files.map((file) => `- ${file.isDir ? "dir" : "file"} ${file.path}`).join("\n"),
    });
  },

  async inspectPreview(session: WorkbenchSession, url: string): Promise<WorkbenchPreviewInspection> {
    const screenshot = await this.screenshot(session, { url });
    const domProbe = await probePreviewDom(url);
    return {
      url,
      httpStatus: domProbe.httpStatus,
      screenshot,
      domText: domProbe.domText,
      visibleElements: domProbe.visibleElements,
      consoleErrors: domProbe.browserErrors ?? [],
      pageErrors: domProbe.error ? [domProbe.error] : [],
    };
  },

  async captureArtifact(
    session: WorkbenchSession,
    input: WorkbenchCaptureArtifactInput
  ): Promise<{ artifact: WorkbenchArtifact; event: WorkbenchEvent }> {
    const storageKey = `workbench/${session.id}/${input.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${makeId("art")}`;

    const artifact = await store.addWorkbenchArtifact({
      companyId: session.companyId,
      sessionId: session.id,
      kind: input.kind,
      title: input.title,
      storageKey,
      mimeType: input.mimeType ?? "text/plain",
      sizeBytes: input.sizeBytes ?? (input.content?.length ?? 0),
      createdByAgent: input.createdByAgent ?? session.agentRole,
      sourceEventId: input.sourceEventId,
      path: input.path,
      previewUrl: input.previewUrl,
      metadata: input.metadata
    });

    const event = await store.addWorkbenchEvent({
      companyId: session.companyId,
      sessionId: session.id,
      type: "artifact",
      status: "completed",
      title: `Artifact captured: ${input.title}`,
      content: input.content?.slice(0, 800) ?? `Artifact of kind '${input.kind}' captured.`,
      artifactId: artifact.id
    });

    return { artifact, event };
  }
};

// Register on import
registerWorkbenchProvider(localProvider);

export { localProvider };

async function listFilesRecursive(
  root: string,
  current: string,
  options: { depth: number; includeIgnored: boolean },
): Promise<WorkbenchFileEntry[]> {
  if (options.depth < 0) return [];
  let entries: import("fs").Dirent[] = [];
  try {
    entries = await fs.readdir(current, { withFileTypes: true });
  } catch {
    return [];
  }

  const results: WorkbenchFileEntry[] = [];
  for (const entry of entries) {
    if (!options.includeIgnored && shouldIgnoreTreeEntry(entry.name)) continue;
    const full = path.join(current, entry.name);
    const relative = path.relative(root, full);
    let sizeBytes = 0;
    let modifiedAt = nowIso();
    try {
      const stat = await fs.stat(full);
      sizeBytes = stat.size;
      modifiedAt = stat.mtime.toISOString();
    } catch {
      // Keep best-effort metadata.
    }
    results.push({
      name: entry.name,
      path: relative,
      isDir: entry.isDirectory(),
      sizeBytes,
      modifiedAt,
    });
    if (entry.isDirectory()) {
      results.push(...await listFilesRecursive(root, full, {
        ...options,
        depth: options.depth - 1,
      }));
    }
  }
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

function shouldIgnoreTreeEntry(name: string): boolean {
  return [".git", "node_modules", ".next", "dist", "build", "coverage"].includes(name);
}

function hashFileTree(files: WorkbenchFileEntry[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(`${file.path}:${file.isDir ? "dir" : file.sizeBytes}:${file.modifiedAt}\n`);
  }
  return hash.digest("hex");
}

type PreviewDomProbe = {
  httpStatus?: number;
  domText: string;
  visibleElements: number;
  error?: string;
  /** Runtime console.error + uncaught page errors captured by the browser probe. */
  browserErrors?: string[];
};

/**
 * Probe the preview DOM with a real browser when Playwright + chromium are
 * installed (production containers). The raw-HTML fetch fallback below sees
 * only the server payload — for client-rendered SPAs (the Vite starter) that
 * is an empty `#root` shell, which reports "0 visible elements, 3 text chars"
 * for perfectly working apps and poisons the critic with false blank-UI
 * evidence.
 */
async function probePreviewDomWithBrowser(url: string): Promise<PreviewDomProbe | null> {
  let browser: import("playwright").Browser | undefined;
  try {
    const { isPlaywrightAvailable } = await import("@/lib/workbench-screenshot");
    if (!(await isPlaywrightAvailable())) return null;
    const { chromium } = await import("playwright");
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const browserErrors: string[] = [];
    page.on("pageerror", (error) => {
      const headline = [error.name, error.message].filter(Boolean).join(": ");
      const stackTop = error.stack?.split("\n").slice(0, 4).join(" | ");
      browserErrors.push(stackTop || headline || String(error));
    });
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const text = message.text().trim();
      if (text) browserErrors.push(text);
    });
    page.on("requestfailed", (req) => {
      browserErrors.push(`Request failed: ${req.url()} (${req.failure()?.errorText ?? "unknown"})`);
    });
    page.on("response", (res) => {
      if (res.status() >= 400) browserErrors.push(`HTTP ${res.status()} ${res.url()}`);
    });
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
    await page.waitForTimeout(300);
    const dom = await page.evaluate(() => {
      const bodyText = document.body?.innerText?.replace(/\s+/g, " ").trim() ?? "";
      const visibleElements = Array.from(document.body?.querySelectorAll("button,a,input,textarea,select,main,section,article,h1,h2,h3,p,li") ?? [])
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        }).length;
      return { bodyText, visibleElements };
    });
    return {
      httpStatus: response?.status(),
      domText: dom.bodyText.slice(0, 4000),
      visibleElements: dom.visibleElements,
      browserErrors: browserErrors.map((e) => e.trim()).filter(Boolean).slice(0, 10),
    };
  } catch {
    // Browser probe is best-effort: fall back to the raw fetch probe.
    return null;
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

async function probePreviewDom(url: string): Promise<PreviewDomProbe> {
  const viaBrowser = await probePreviewDomWithBrowser(url);
  if (viaBrowser) return viaBrowser;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text().catch(() => "");
    const bodyText = text
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return {
      httpStatus: response.status,
      domText: bodyText.slice(0, 4000),
      visibleElements: (text.match(/<(button|a|input|textarea|select|main|section|article|h1|h2|h3|p|li)\b/gi) ?? []).length,
    };
  } catch (err) {
    return {
      domText: "",
      visibleElements: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}
