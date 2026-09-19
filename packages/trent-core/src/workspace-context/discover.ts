/**
 * Which files a workspace may speak through, and the path rules that bound them.
 *
 * The order is fixed and load-bearing: the git root's `AGENTS.md`, then its `CLAUDE.md`, then its
 * `.trent/*.md` sorted by name, then the same three sets in the working directory when that is not
 * the root itself. The prelude renders them in this order, so a deeper directory refines the root
 * rather than competing with it.
 *
 * Path rules, the same shape `tools/file_ops/paths.ts` uses: every candidate is resolved through
 * `realpath` first and must still land under the workspace root or the working directory. A symlink
 * pointing anywhere else is refused by name, never followed, and never read.
 */
import fs from "node:fs";
import path from "node:path";

/** Files at each level, in the order the prelude renders them. `.trent/*.md` follows, sorted. */
const NAMED_FILES: readonly string[] = ["AGENTS.md", "CLAUDE.md"];
const TRENT_DIR = ".trent";
/** A file larger than this is read as a head only; both character caps then cut it further. */
const MAX_READ_BYTES = 1_000_000;

export interface WorkspaceCandidate {
  /** POSIX path relative to the workspace root, the key every block and refusal carries. */
  readonly path: string;
  /** Absolute host path as it was found, before `realpath`. */
  readonly hostPath: string;
}

export interface ResolvedWorkspace {
  readonly workspaceRoot: string;
  readonly cwd: string;
}

function isUnder(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

/** realpath when the path exists, the path itself when it does not; never throws. */
function realpathOrSelf(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

/**
 * The workspace root: the nearest ancestor of `cwd` holding `.git` (a directory or a worktree
 * file), or `cwd` itself when there is none. Both are realpaths, so a symlinked checkout and a
 * `/var` temp directory on macOS compare equal to what the candidates resolve to.
 */
export function resolveWorkspaceRoot(cwd: string): ResolvedWorkspace {
  const start = realpathOrSelf(cwd);
  let probe = start;
  for (;;) {
    if (fs.existsSync(path.join(probe, ".git"))) return { workspaceRoot: probe, cwd: start };
    const parent = path.dirname(probe);
    if (parent === probe) return { workspaceRoot: start, cwd: start };
    probe = parent;
  }
}

/** `.trent/*.md` in one directory, sorted by file name. Symlinks are listed; the guard judges them. */
function trentFiles(dir: string): string[] {
  const trentDir = path.join(dir, TRENT_DIR);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(trentDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => (e.isFile() || e.isSymbolicLink()) && e.name.toLowerCase().endsWith(".md"))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => path.join(trentDir, name));
}

/** Every candidate that exists, in the documented order, deduplicated by host path. */
export function workspaceCandidates(workspace: ResolvedWorkspace): WorkspaceCandidate[] {
  const dirs = [workspace.workspaceRoot];
  if (workspace.cwd !== workspace.workspaceRoot && isUnder(workspace.cwd, workspace.workspaceRoot)) {
    dirs.push(workspace.cwd);
  }
  const seen = new Set<string>();
  const out: WorkspaceCandidate[] = [];
  for (const dir of dirs) {
    const hostPaths = [...NAMED_FILES.map((name) => path.join(dir, name)), ...trentFiles(dir)];
    for (const hostPath of hostPaths) {
      if (seen.has(hostPath) || !fs.existsSync(hostPath)) continue;
      seen.add(hostPath);
      out.push({ path: displayPath(workspace.workspaceRoot, hostPath), hostPath });
    }
  }
  return out;
}

/** Root-relative POSIX when the file is under the root; the absolute path otherwise. */
export function displayPath(workspaceRoot: string, hostPath: string): string {
  const relative = path.relative(workspaceRoot, hostPath);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return hostPath;
  return relative.split(path.sep).join("/");
}

export interface CandidateRead {
  readonly text: string;
  /** True when the byte cap stopped the read, so the file is at least `text.length` characters. */
  readonly partial: boolean;
}

export type CandidateReadResult = { ok: true; read: CandidateRead } | { ok: false; reason: string };

/**
 * Resolves the candidate, refuses anything that leaves the workspace, and reads what is left.
 * The refusal reason names the rule, never the path the symlink pointed at.
 */
export function readCandidate(workspace: ResolvedWorkspace, candidate: WorkspaceCandidate): CandidateReadResult {
  let resolved: string;
  try {
    resolved = fs.realpathSync(candidate.hostPath);
  } catch {
    return { ok: false, reason: "the file could not be resolved on disk" };
  }
  if (!isUnder(resolved, workspace.workspaceRoot) && !isUnder(resolved, workspace.cwd)) {
    return { ok: false, reason: "resolves outside the workspace root, so it was not followed" };
  }
  let stats: fs.Stats;
  try {
    stats = fs.statSync(resolved);
  } catch {
    return { ok: false, reason: "the file could not be read" };
  }
  if (!stats.isFile()) return { ok: false, reason: "not a regular file" };
  try {
    if (stats.size <= MAX_READ_BYTES) return { ok: true, read: { text: fs.readFileSync(resolved, "utf8"), partial: false } };
    return { ok: true, read: { text: readHead(resolved, MAX_READ_BYTES), partial: true } };
  } catch {
    return { ok: false, reason: "the file could not be read" };
  }
}

function readHead(file: string, maxBytes: number): string {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const read = fs.readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}
