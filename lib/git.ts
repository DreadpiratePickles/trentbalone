import { execFile } from "child_process";
import { promisify } from "util";

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

  return {
    status: "error",
    message: res.stderr || `merge-tree exited with code ${res.exitCode}`
  };
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
