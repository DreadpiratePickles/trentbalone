import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

const execFileAsync = promisify(execFile);

export function parseGitVersion(versionStr: string): { major: number; minor: number } {
  const match = versionStr.match(/version\s+(\d+)\.(\d+)/i);
  if (!match) {
    return { major: 0, minor: 0 };
  }
  return {
    major: parseInt(match[1]!, 10),
    minor: parseInt(match[2]!, 10)
  };
}

export async function verifyGitVersion(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["--version"], { cwd, timeout: 5000 });
    const { major, minor } = parseGitVersion(stdout);
    if (major > 2) return true;
    if (major === 2 && minor >= 38) return true;
    return false;
  } catch {
    return false;
  }
}

export class GitError extends Error {
  constructor(public code: number, message: string) {
    super(message);
    this.name = "GitError";
  }
}

const DEFAULT_TIMEOUT = 30000;

export async function execGit(
  args: string[],
  cwd: string,
  options?: { timeoutMs?: number; stdin?: string }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = execFile(
      "git",
      args,
      {
        cwd,
        timeout: options?.timeoutMs ?? DEFAULT_TIMEOUT,
        maxBuffer: 10 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        const exitCode = error ? ((error as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0;
        resolve({
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          exitCode
        });
      }
    );

    if (options?.stdin && child.stdin) {
      child.stdin.write(options.stdin);
      child.stdin.end();
    }
  });
}

export async function getDiff(cwd: string, base: string, head: string): Promise<string> {
  const res = await execGit(["diff", `${base}..${head}`], cwd);
  if (res.exitCode !== 0) {
    throw new GitError(res.exitCode, `git diff failed: ${res.stderr}`);
  }
  return res.stdout;
}

export type GitMergeResult =
  | { status: "clean"; treeOid: string }
  | { status: "conflict"; conflictedFiles: string[] }
  | { status: "error"; message: string };

export async function detectMergeConflicts(
  cwd: string,
  branchA: string,
  branchB: string
): Promise<GitMergeResult> {
  const res = await execGit(["merge-tree", "--write-tree", branchA, branchB], cwd);

  if (res.exitCode === 0) {
    const treeOid = res.stdout.trim().split("\n")[0] ?? "";
    return { status: "clean", treeOid };
  }

  if (res.exitCode === 1) {
    // merge-tree --write-tree emits conflict info in stdout:
    // "CONFLICT (content): Merge conflict in a.txt"
    const conflictedFiles = new Set<string>();
    for (const line of res.stdout.split("\n")) {
      const match = line.match(/Merge conflict in (.+)$/);
      if (match?.[1]) {
        conflictedFiles.add(match[1].trim());
      }
    }
    return {
      status: "conflict",
      conflictedFiles: Array.from(conflictedFiles)
    };
  }

  if (isUnsupportedWriteTree(res.stderr)) {
    return detectMergeConflictsWithWorktree(cwd, branchA, branchB);
  }

  return {
    status: "error",
    message: res.stderr || `merge-tree exited with code ${res.exitCode}`
  };
}

function isUnsupportedWriteTree(stderr: string): boolean {
  return /unknown (option|switch).*write-tree|usage: git merge-tree|--write-tree/i.test(stderr);
}

async function detectMergeConflictsWithWorktree(
  cwd: string,
  branchA: string,
  branchB: string
): Promise<GitMergeResult> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "trent-merge-tree-"));
  const add = await execGit(["worktree", "add", "--detach", tmp, branchA], cwd);
  if (add.exitCode !== 0) {
    await fs.rm(tmp, { recursive: true, force: true });
    return { status: "error", message: add.stderr || `worktree add exited with code ${add.exitCode}` };
  }

  try {
    const merge = await execGit(["merge", "--no-commit", "--no-ff", branchB], tmp);
    if (merge.exitCode === 0) {
      const tree = await execGit(["write-tree"], tmp);
      if (tree.exitCode === 0) return { status: "clean", treeOid: tree.stdout.trim() };
      return { status: "error", message: tree.stderr || `write-tree exited with code ${tree.exitCode}` };
    }
    if (merge.exitCode === 1) {
      const files = await execGit(["diff", "--name-only", "--diff-filter=U"], tmp);
      return {
        status: "conflict",
        conflictedFiles: files.stdout.split("\n").map((line) => line.trim()).filter(Boolean),
      };
    }
    return { status: "error", message: merge.stderr || `merge exited with code ${merge.exitCode}` };
  } finally {
    await execGit(["merge", "--abort"], tmp).catch(() => undefined);
    const removed = await execGit(["worktree", "remove", tmp], cwd);
    if (removed.exitCode !== 0) {
      await fs.rm(tmp, { recursive: true, force: true });
      await execGit(["worktree", "prune"], cwd).catch(() => undefined);
    }
  }
}

export type GitPatchResult =
  | { status: "clean" }
  | { status: "conflict"; rejectedFiles: string[] }
  | { status: "error"; message: string };

function parseRejectedFiles(stderr: string): string[] {
  const rejectedFiles = new Set<string>();
  for (const line of stderr.split("\n")) {
    const matchFailed = line.match(/error:\s+patch failed:\s+([^:]+):/i);
    const matchNoApply = line.match(/error:\s+([^:]+):\s+patch does not apply/i);
    if (matchFailed?.[1]) rejectedFiles.add(matchFailed[1].trim());
    if (matchNoApply?.[1]) rejectedFiles.add(matchNoApply[1].trim());
  }
  return Array.from(rejectedFiles);
}

export async function detectPatchConflicts(cwd: string, patchContent: string): Promise<GitPatchResult> {
  const res = await execGit(["apply", "--check", "-"], cwd, { stdin: patchContent });

  if (res.exitCode === 0) {
    return { status: "clean" };
  }

  if (res.exitCode === 1) {
    return { status: "conflict", rejectedFiles: parseRejectedFiles(res.stderr) };
  }

  return {
    status: "error",
    message: res.stderr || `git apply --check exited with code ${res.exitCode}`
  };
}

export async function applyPatch(
  cwd: string,
  patchContent: string,
  options?: { threeWay?: boolean }
): Promise<GitPatchResult> {
  const args = ["apply"];
  if (options?.threeWay) {
    args.push("--3way");
  }
  args.push("-");

  const res = await execGit(args, cwd, { stdin: patchContent });

  if (res.exitCode === 0) {
    return { status: "clean" };
  }

  if (res.exitCode === 1) {
    return { status: "conflict", rejectedFiles: parseRejectedFiles(res.stderr) };
  }

  return {
    status: "error",
    message: res.stderr || `git apply exited with code ${res.exitCode}`
  };
}
