/**
 * Path policy for `file_ops`: workspace confinement by realpath AFTER symlink resolution
 * (Hermes `path_security.py:7-18`, `file_tools_write_guards.py:139-202`), the read/write deny
 * list (`file_safety.py:189-259`, `file_tools_write_guards.py:21-25`) and the protected
 * instruction files whose writes always need a human.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Sandbox } from "../sandbox.js";
import { spilloverDir } from "../spillover.js";
import type { ToolContext } from "../types.js";

export interface ResolvedPath {
  /** Absolute host path, symlinks resolved. */
  readonly hostPath: string;
  /** The same file as the sandbox addresses it. */
  readonly sandboxPath: string;
  /** Workspace-relative POSIX path for messages; spillover files keep their absolute host path. */
  readonly display: string;
  readonly inSpillover: boolean;
}

export class PathPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathPolicyError";
  }
}

const PROTECTED_BASENAMES = new Set(["claude.md", "agents.md", "soul.md", "development_methodology_and_coding_rulebook.md"]);

/** Instruction files a seat may never rewrite without a human: matched on the resolved path too. */
export function isProtectedInstructionFile(relative: string): boolean {
  const segments = relative.split("/").map((s) => s.toLowerCase());
  const basename = segments[segments.length - 1] ?? "";
  return PROTECTED_BASENAMES.has(basename) || segments.includes(".trent");
}

/** Secrets and control files no seat reads or writes, whatever the approval state. */
export function deniedReason(relative: string, hostPath: string): string | undefined {
  const segments = relative.split("/");
  const basename = segments[segments.length - 1] ?? "";
  if (segments.some((s) => s === ".env" || s.startsWith(".env."))) return ".env files are denied";
  if (relative === ".git/config" || relative.endsWith("/.git/config")) return ".git/config is denied";
  if (segments.includes("mcp-tokens")) return "mcp-tokens directories are denied";
  if (basename === "docker.sock") return "the Docker socket is denied";
  const home = os.homedir();
  for (const dir of [".ssh", ".aws"]) {
    const root = path.join(home, dir);
    if (hostPath === root || hostPath.startsWith(`${root}${path.sep}`)) return `~/${dir} is denied`;
  }
  return undefined;
}

/** realpath of `target`, or of its nearest existing ancestor joined with the missing remainder. */
function realpathLenient(target: string): string {
  const missing: string[] = [];
  let probe = target;
  for (;;) {
    try {
      return path.join(fs.realpathSync(probe), ...missing.reverse());
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) throw new PathPolicyError(`cannot resolve ${target}`);
      missing.push(path.basename(probe));
      probe = parent;
    }
  }
}

function isUnder(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

/**
 * Resolves a model-supplied path. Accepts workspace-relative paths, absolute paths under the
 * workspace (host or sandbox spelling), and — for reads — absolute paths into the profile's
 * spillover directory, so a spilled tool result can be paged with `read_file`.
 */
export function resolveWorkspacePath(
  ctx: ToolContext,
  sandbox: Sandbox,
  input: string,
  purpose: "read" | "write",
): ResolvedPath {
  if (!input || input.includes("\0")) throw new PathPolicyError("path is empty or contains NUL");
  const workspaceReal = fs.realpathSync(ctx.workspace);
  const spillReal = realpathLenient(spilloverDir(ctx.profileDir));

  let hostCandidate: string;
  if (path.posix.isAbsolute(input) && (input === sandbox.workspaceRoot || input.startsWith(`${sandbox.workspaceRoot}/`))) {
    hostCandidate = path.join(ctx.workspace, path.posix.relative(sandbox.workspaceRoot, input));
  } else if (path.isAbsolute(input)) {
    hostCandidate = input;
  } else {
    hostCandidate = path.resolve(ctx.workspace, input);
  }
  const real = realpathLenient(hostCandidate);

  if (isUnder(real, spillReal)) {
    if (purpose === "write") throw new PathPolicyError("spillover files are read-only");
    return { hostPath: real, sandboxPath: sandbox.toSandboxPath(real), display: real, inSpillover: true };
  }
  if (!isUnder(real, workspaceReal)) {
    throw new PathPolicyError(`${input} resolves outside the workspace (${real}); access denied`);
  }
  const relative = path.relative(workspaceReal, real).split(path.sep).join("/");
  const denied = deniedReason(relative, real);
  if (denied) throw new PathPolicyError(`${input}: ${denied}`);
  // Map through the ORIGINAL workspace path: the sandbox mount is keyed on ctx.workspace as given.
  const hostPath = path.join(ctx.workspace, relative);
  return { hostPath, sandboxPath: sandbox.toSandboxPath(hostPath), display: relative, inSpillover: false };
}
