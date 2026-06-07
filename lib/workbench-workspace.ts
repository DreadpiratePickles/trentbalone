/**
 * Per-company persistent workspace: cached git clone + dep install across sessions.
 *
 * Layout under WORKSPACE_ROOT:
 *   companies/{companyId}/repo/          ← main git clone
 *   companies/{companyId}/.workspace.json ← state file
 *   companies/{companyId}/worktrees/{sessionId}/ ← per-session git worktree
 */

import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { nowIso } from "@/lib/utils";

const execFileAsync = promisify(execFile);

/** Read at call time so tests can override WORKBENCH_STORAGE_ROOT after import. */
export function getWorkspaceRoot(): string {
  return process.env.WORKBENCH_STORAGE_ROOT
    ? path.join(process.env.WORKBENCH_STORAGE_ROOT, "companies")
    : path.join(os.tmpdir(), "trent-workbench", "companies");
}

/** @deprecated use getWorkspaceRoot() */
export const WORKSPACE_ROOT = getWorkspaceRoot();

export type DepTool = "npm" | "pnpm" | "yarn" | "pip" | "poetry" | "none";

export type WorkspaceState = {
  companyId: string;
  repoUrl: string;
  clonedAt: string;
  lastSyncedAt: string;
  headSha?: string;
};

const STATE_FILE = ".workspace.json";

// ── Path helpers ──────────────────────────────────────────────────────────────

export function companyWorkspaceDir(companyId: string): string {
  return path.join(getWorkspaceRoot(), companyId, "repo");
}

export function sessionWorktreeDir(companyId: string, sessionId: string): string {
  return path.join(getWorkspaceRoot(), companyId, "worktrees", sessionId);
}

// ── State persistence ─────────────────────────────────────────────────────────

export async function loadWorkspaceState(companyId: string): Promise<WorkspaceState | null> {
  try {
    const p = path.join(getWorkspaceRoot(), companyId, STATE_FILE);
    const raw = await fs.readFile(p, "utf8");
    return JSON.parse(raw) as WorkspaceState;
  } catch {
    return null;
  }
}

async function saveWorkspaceState(state: WorkspaceState): Promise<void> {
  const dir = path.join(getWorkspaceRoot(), state.companyId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, STATE_FILE), JSON.stringify(state, null, 2), "utf8");
}

// ── Git helpers ───────────────────────────────────────────────────────────────

export type GitEnv = Record<string, string | undefined>;

async function gitExec(
  cwd: string,
  args: string[],
  env?: GitEnv
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      env: { ...process.env, ...env },
      timeout: 120_000,
    });
    return { stdout: stdout.toString(), stderr: stderr.toString(), exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string | Buffer; stderr?: string | Buffer; code?: number };
    return {
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() ?? "",
      exitCode: typeof e.code === "number" ? e.code : 1,
    };
  }
}

async function isGitRepo(dir: string): Promise<boolean> {
  const result = await gitExec(dir, ["rev-parse", "--git-dir"]);
  return result.exitCode === 0;
}

async function headSha(dir: string): Promise<string | undefined> {
  const result = await gitExec(dir, ["rev-parse", "HEAD"]);
  return result.exitCode === 0 ? result.stdout.trim() : undefined;
}

// ── Workspace sync ────────────────────────────────────────────────────────────

export type SyncWorkspaceOptions = {
  /** Git credentials as env vars (e.g. GIT_TOKEN, GIT_ASKPASS). */
  env?: GitEnv;
};

/**
 * Clone the repo if not cached, or fetch + reset to the latest branch tip.
 * Safe to call multiple times — idempotent per (companyId, repoUrl).
 */
export async function syncWorkspace(
  companyId: string,
  repoUrl: string,
  branch?: string,
  options?: SyncWorkspaceOptions
): Promise<{ workdir: string; state: WorkspaceState }> {
  const workdir = companyWorkspaceDir(companyId);
  const existing = await loadWorkspaceState(companyId);

  const repoChanged = existing && existing.repoUrl !== repoUrl;
  const needsClone = !existing || repoChanged || !(await isGitRepo(workdir));

  if (repoChanged) {
    await fs.rm(workdir, { recursive: true, force: true });
  }
  await fs.mkdir(workdir, { recursive: true });

  if (needsClone) {
    const result = await gitExec(workdir, ["clone", "--filter=blob:none", repoUrl, "."], options?.env);
    if (result.exitCode !== 0) {
      throw new Error(`git clone failed: ${result.stderr.trim()}`);
    }
  } else {
    const fetchResult = await gitExec(workdir, ["fetch", "--prune"], options?.env);
    if (fetchResult.exitCode !== 0) {
      console.warn(`[workspace] git fetch failed for ${companyId}: ${fetchResult.stderr.trim()}`);
    }
  }

  if (branch) {
    const checkout = await gitExec(workdir, ["checkout", branch]);
    if (checkout.exitCode !== 0) {
      const createBranch = await gitExec(workdir, ["checkout", "-b", branch, `origin/${branch}`]);
      if (createBranch.exitCode !== 0) {
        throw new Error(`git checkout ${branch} failed: ${createBranch.stderr.trim()}`);
      }
    }
    await gitExec(workdir, ["reset", "--hard", `origin/${branch}`]);
  }

  const sha = await headSha(workdir);
  const now = nowIso();
  const state: WorkspaceState = {
    companyId,
    repoUrl,
    clonedAt: existing?.clonedAt ?? now,
    lastSyncedAt: now,
    headSha: sha,
  };
  await saveWorkspaceState(state);
  return { workdir, state };
}

// ── Session worktrees ─────────────────────────────────────────────────────────

/**
 * Create an isolated git worktree for a session from the company's cached clone.
 * Returns the worktree path for use as the session workdir.
 */
export async function createSessionWorktree(
  companyId: string,
  sessionId: string,
  branch?: string
): Promise<string> {
  const repoDir = companyWorkspaceDir(companyId);
  const wtDir = sessionWorktreeDir(companyId, sessionId);

  await fs.mkdir(path.dirname(wtDir), { recursive: true });

  const args = ["worktree", "add"];
  if (branch) {
    // Use existing branch if present, otherwise create it from HEAD
    const ref = await gitExec(repoDir, ["show-ref", "--verify", `refs/heads/${branch}`]);
    if (ref.exitCode === 0) {
      args.push(wtDir, branch);
    } else {
      args.push("-b", branch, wtDir);
    }
  } else {
    args.push("--detach", wtDir);
  }

  const result = await gitExec(repoDir, args);
  if (result.exitCode !== 0) {
    throw new Error(`git worktree add failed: ${result.stderr.trim()}`);
  }
  return wtDir;
}

/**
 * Remove a session's git worktree. Called on session stop.
 * No-op if the worktree doesn't exist.
 */
export async function removeSessionWorktree(
  companyId: string,
  sessionId: string
): Promise<void> {
  const repoDir = companyWorkspaceDir(companyId);
  const wtDir = sessionWorktreeDir(companyId, sessionId);

  try {
    await fs.access(wtDir);
  } catch {
    return; // already gone
  }

  await gitExec(repoDir, ["worktree", "remove", "--force", wtDir]);
}

// ── Dependency detection & install ───────────────────────────────────────────

/**
 * Detect the dependency manager from project files.
 * Lock file presence takes priority over package.json alone.
 */
export async function detectDepTool(workdir: string): Promise<DepTool> {
  const exists = async (f: string) => {
    try { await fs.access(path.join(workdir, f)); return true; } catch { return false; }
  };

  if (await exists("pnpm-lock.yaml")) return "pnpm";
  if (await exists("yarn.lock")) return "yarn";
  if (await exists("package.json")) return "npm";
  if (await exists("poetry.lock")) return "poetry";
  if (await exists("requirements.txt")) return "pip";
  return "none";
}

type DepConfig = { lockFile: string; depsDir: string; cmd: string };

function depConfig(tool: DepTool): DepConfig | null {
  switch (tool) {
    case "pnpm": return { lockFile: "pnpm-lock.yaml", depsDir: "node_modules", cmd: "pnpm install --frozen-lockfile" };
    case "yarn": return { lockFile: "yarn.lock", depsDir: "node_modules", cmd: "yarn install --frozen-lockfile" };
    case "npm": return { lockFile: "package-lock.json", depsDir: "node_modules", cmd: "npm ci" };
    case "poetry": return { lockFile: "poetry.lock", depsDir: ".venv", cmd: "poetry install --no-interaction" };
    case "pip": return { lockFile: "requirements.txt", depsDir: ".venv", cmd: "pip install -r requirements.txt" };
    default: return null;
  }
}

/**
 * Install deps if the lock file is newer than the deps directory.
 * Skips install when deps appear fresh. No-op for tool=none.
 */
export async function ensureDeps(workdir: string, tool?: DepTool): Promise<void> {
  const resolved = tool ?? await detectDepTool(workdir);
  const cfg = depConfig(resolved);
  if (!cfg) return;

  let needsInstall = true;
  try {
    const [lockStat, depsStat] = await Promise.all([
      fs.stat(path.join(workdir, cfg.lockFile)),
      fs.stat(path.join(workdir, cfg.depsDir)),
    ]);
    needsInstall = lockStat.mtimeMs > depsStat.mtimeMs;
  } catch {
    // lock file or deps dir missing → install
  }

  if (!needsInstall) return;

  const [cmd, ...args] = cfg.cmd.split(" ");
  try {
    await execFileAsync(cmd!, args, { cwd: workdir, timeout: 300_000 });
  } catch (err: unknown) {
    const e = err as { message?: string };
    throw new Error(`Dependency install failed (${resolved}): ${e.message}`);
  }
}
