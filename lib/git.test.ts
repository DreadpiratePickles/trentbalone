import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { parseGitVersion, verifyGitVersion, getDiff, detectMergeConflicts, detectPatchConflicts, applyPatch } from "./git";

const exec = promisify(execFile);

async function createTempGitRepo(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "trent-git-test-"));
  await exec("git", ["init", "-b", "main"], { cwd: tempDir });
  await exec("git", ["config", "user.name", "test"], { cwd: tempDir });
  await exec("git", ["config", "user.email", "test@test.com"], { cwd: tempDir });
  return tempDir;
}

describe("git-version helpers", () => {
  it("correctly parses semantic git versions", () => {
    expect(parseGitVersion("git version 2.39.2")).toEqual({ major: 2, minor: 39 });
    expect(parseGitVersion("git version 2.38.0.windows.1")).toEqual({ major: 2, minor: 38 });
    expect(parseGitVersion("git version 1.9.5")).toEqual({ major: 1, minor: 9 });
  });

  it("evaluates if current git version is valid", async () => {
    // Assuming test environment has Git 2.38+
    const isValid = await verifyGitVersion(process.cwd());
    expect(typeof isValid).toBe("boolean");
  });
});

describe("git-diff helpers", () => {
  let repoPath: string;

  beforeEach(async () => {
    repoPath = await createTempGitRepo();
  });

  afterEach(async () => {
    await fs.rm(repoPath, { recursive: true, force: true });
  });

  it("generates git diff between commits", async () => {
    const file = path.join(repoPath, "a.txt");

    await fs.writeFile(file, "hello\n");
    await exec("git", ["add", "a.txt"], { cwd: repoPath });
    await exec("git", ["commit", "-m", "first"], { cwd: repoPath });

    await fs.writeFile(file, "hello\nworld\n");
    await exec("git", ["add", "a.txt"], { cwd: repoPath });
    await exec("git", ["commit", "-m", "second"], { cwd: repoPath });

    const diff = await getDiff(repoPath, "HEAD~1", "HEAD");
    expect(diff).toContain("+world");
  });
});

describe("git-merge conflict detection", () => {
  let repoPath: string;

  beforeEach(async () => {
    repoPath = await createTempGitRepo();
  });

  afterEach(async () => {
    await fs.rm(repoPath, { recursive: true, force: true });
  });

  it("detects clean merges and returns tree SHA", async () => {
    const file = path.join(repoPath, "a.txt");

    await fs.writeFile(file, "line 1\nline 2\nline 3\n");
    await exec("git", ["add", "a.txt"], { cwd: repoPath });
    await exec("git", ["commit", "-m", "root"], { cwd: repoPath });

    await exec("git", ["checkout", "-b", "branch-a"], { cwd: repoPath });
    await fs.writeFile(file, "line A\nline 2\nline 3\n");
    await exec("git", ["add", "a.txt"], { cwd: repoPath });
    await exec("git", ["commit", "-m", "change A"], { cwd: repoPath });

    await exec("git", ["checkout", "main"], { cwd: repoPath });
    await exec("git", ["checkout", "-b", "branch-b"], { cwd: repoPath });
    await fs.writeFile(file, "line 1\nline 2\nline B\n");
    await exec("git", ["add", "a.txt"], { cwd: repoPath });
    await exec("git", ["commit", "-m", "change B"], { cwd: repoPath });

    const res = await detectMergeConflicts(repoPath, "branch-a", "branch-b");
    expect(res.status).toBe("clean");
    if (res.status === "clean") {
      expect(res.treeOid).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it("detects conflict and parses conflicted files", async () => {
    const file = path.join(repoPath, "a.txt");

    await fs.writeFile(file, "line 1\n");
    await exec("git", ["add", "a.txt"], { cwd: repoPath });
    await exec("git", ["commit", "-m", "root"], { cwd: repoPath });

    await exec("git", ["checkout", "-b", "branch-a"], { cwd: repoPath });
    await fs.writeFile(file, "line A\n");
    await exec("git", ["add", "a.txt"], { cwd: repoPath });
    await exec("git", ["commit", "-m", "change A"], { cwd: repoPath });

    await exec("git", ["checkout", "main"], { cwd: repoPath });
    await exec("git", ["checkout", "-b", "branch-b"], { cwd: repoPath });
    await fs.writeFile(file, "line B\n");
    await exec("git", ["add", "a.txt"], { cwd: repoPath });
    await exec("git", ["commit", "-m", "change B"], { cwd: repoPath });

    const res = await detectMergeConflicts(repoPath, "branch-a", "branch-b");
    expect(res.status).toBe("conflict");
    if (res.status === "conflict") {
      expect(res.conflictedFiles).toContain("a.txt");
    }
  });
});

const patchContent = [
  "diff --git a/a.txt b/a.txt",
  "index d9d0fb3..ca6e3eb 100644",
  "--- a/a.txt",
  "+++ b/a.txt",
  "@@ -1,3 +1,4 @@",
  " line 1",
  "+inserted line",
  " line 2",
  " line 3"
].join("\n") + "\n";

const conflictPatch = [
  "diff --git a/a.txt b/a.txt",
  "index abc1234..def5678 100644",
  "--- a/a.txt",
  "+++ b/a.txt",
  "@@ -1,2 +1,2 @@",
  "-different root line",
  "+line X",
  " line 2"
].join("\n") + "\n";

describe("git-patch operations", () => {
  let repoPath: string;

  beforeEach(async () => {
    repoPath = await createTempGitRepo();
  });

  afterEach(async () => {
    await fs.rm(repoPath, { recursive: true, force: true });
  });

  it("checks patch and detects clean state", async () => {
    const file = path.join(repoPath, "a.txt");
    await fs.writeFile(file, "line 1\nline 2\nline 3\n");
    await exec("git", ["add", "a.txt"], { cwd: repoPath });
    await exec("git", ["commit", "-m", "init"], { cwd: repoPath });

    const check = await detectPatchConflicts(repoPath, patchContent);
    expect(check.status).toBe("clean");
  });

  it("detects patch conflict and parses rejected files", async () => {
    const file = path.join(repoPath, "a.txt");
    await fs.writeFile(file, "line 1\nline 2\nline 3\n");
    await exec("git", ["add", "a.txt"], { cwd: repoPath });
    await exec("git", ["commit", "-m", "init"], { cwd: repoPath });

    const check = await detectPatchConflicts(repoPath, conflictPatch);
    expect(check.status).toBe("conflict");
    if (check.status === "conflict") {
      expect(check.rejectedFiles).toContain("a.txt");
    }
  });

  it("applies patch cleanly with three-way merge resolution", async () => {
    const file = path.join(repoPath, "a.txt");
    await fs.writeFile(file, "line 1\nline 2\nline 3\n");
    await exec("git", ["add", "a.txt"], { cwd: repoPath });
    await exec("git", ["commit", "-m", "init"], { cwd: repoPath });

    const res = await applyPatch(repoPath, patchContent, { threeWay: true });
    expect(res.status).toBe("clean");
    const content = await fs.readFile(file, "utf-8");
    expect(content).toContain("inserted line");
  });
});
