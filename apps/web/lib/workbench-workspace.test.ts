import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import {
  companyWorkspaceDir,
  sessionWorktreeDir,
  loadWorkspaceState,
  detectDepTool,
  ensureDeps,
  syncWorkspace,
} from "@/lib/workbench-workspace";

// ── Test root ─────────────────────────────────────────────────────────────────

let testRoot: string;

beforeEach(async () => {
  testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "trent-ws-test-"));
  // Override the WORKSPACE_ROOT via env so the module uses testRoot
  process.env.WORKBENCH_STORAGE_ROOT = testRoot;
});

afterEach(async () => {
  await fs.rm(testRoot, { recursive: true, force: true });
  delete process.env.WORKBENCH_STORAGE_ROOT;
});

// ── Path helpers ──────────────────────────────────────────────────────────────

describe("companyWorkspaceDir", () => {
  it("returns companies/{companyId}/repo under WORKSPACE_ROOT", () => {
    const dir = companyWorkspaceDir("co_123");
    expect(dir).toContain(path.join("companies", "co_123", "repo"));
  });
});

describe("sessionWorktreeDir", () => {
  it("returns companies/{companyId}/worktrees/{sessionId}", () => {
    const dir = sessionWorktreeDir("co_123", "sess_456");
    expect(dir).toContain(path.join("companies", "co_123", "worktrees", "sess_456"));
  });
});

// ── State persistence ─────────────────────────────────────────────────────────

describe("loadWorkspaceState", () => {
  it("returns null when no state file exists", async () => {
    const result = await loadWorkspaceState("nonexistent_company");
    expect(result).toBeNull();
  });

  it("reads back a state file written manually", async () => {
    const companyId = "co_state_test";
    // WORKBENCH_STORAGE_ROOT is set to testRoot, so the companies dir is inside it
    const stateDir = path.join(testRoot, "companies", companyId);
    await fs.mkdir(stateDir, { recursive: true });
    const state = {
      companyId,
      repoUrl: "https://github.com/org/repo",
      clonedAt: "2026-01-01T00:00:00.000Z",
      lastSyncedAt: "2026-01-02T00:00:00.000Z",
      headSha: "abc123",
    };
    await fs.writeFile(path.join(stateDir, ".workspace.json"), JSON.stringify(state));
    const loaded = await loadWorkspaceState(companyId);
    expect(loaded).toEqual(state);
  });
});

// ── Dependency detection ──────────────────────────────────────────────────────

async function makeDepDir(...files: string[]): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "trent-dep-"));
  for (const f of files) {
    await fs.writeFile(path.join(dir, f), "placeholder");
  }
  return dir;
}

describe("detectDepTool", () => {
  it("detects pnpm from pnpm-lock.yaml", async () => {
    const dir = await makeDepDir("pnpm-lock.yaml", "package.json");
    expect(await detectDepTool(dir)).toBe("pnpm");
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("detects yarn from yarn.lock", async () => {
    const dir = await makeDepDir("yarn.lock", "package.json");
    expect(await detectDepTool(dir)).toBe("yarn");
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("detects npm from package.json (no lock file)", async () => {
    const dir = await makeDepDir("package.json");
    expect(await detectDepTool(dir)).toBe("npm");
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("detects poetry from poetry.lock", async () => {
    const dir = await makeDepDir("poetry.lock");
    expect(await detectDepTool(dir)).toBe("poetry");
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("detects pip from requirements.txt", async () => {
    const dir = await makeDepDir("requirements.txt");
    expect(await detectDepTool(dir)).toBe("pip");
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns none for empty directory", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "trent-none-"));
    expect(await detectDepTool(dir)).toBe("none");
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("prioritises pnpm-lock.yaml over yarn.lock", async () => {
    const dir = await makeDepDir("pnpm-lock.yaml", "yarn.lock", "package.json");
    expect(await detectDepTool(dir)).toBe("pnpm");
    await fs.rm(dir, { recursive: true, force: true });
  });
});

// ── ensureDeps ─────────────────────────────────────────────────────────────────

describe("ensureDeps", () => {
  it("resolves without error for tool=none (no install executed)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "trent-none-"));
    try {
      await expect(ensureDeps(dir, "none")).resolves.toBeUndefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("skips install when node_modules is newer than package-lock.json", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "trent-ensure-"));
    try {
      await fs.writeFile(path.join(dir, "package-lock.json"), "{}");
      await fs.mkdir(path.join(dir, "node_modules"), { recursive: true });
      // Set node_modules mtime to be 1 second in the future relative to the lock file
      const future = new Date(Date.now() + 10_000);
      await fs.utimes(path.join(dir, "node_modules"), future, future);

      // Should not throw (if install were run, npm ci would fail on a placeholder lockfile)
      await expect(ensureDeps(dir, "npm")).resolves.toBeUndefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

// ── syncWorkspace (git integration) ──────────────────────────────────────────

describe("syncWorkspace", () => {
  it("clones a local bare repo and records state", async () => {
    // Set up a minimal bare git repo as the "remote"
    const remoteDir = await fs.mkdtemp(path.join(os.tmpdir(), "trent-remote-"));
    const { execSync } = await import("child_process");

    try {
      execSync("git init --bare .", { cwd: remoteDir, stdio: "pipe" });

      // Clone it into a temp workdir so we can make a commit
      const seedDir = await fs.mkdtemp(path.join(os.tmpdir(), "trent-seed-"));
      try {
        execSync(`git clone ${remoteDir} .`, { cwd: seedDir, stdio: "pipe" });
        execSync("git config user.email 'test@test.com'", { cwd: seedDir, stdio: "pipe" });
        execSync("git config user.name 'Test'", { cwd: seedDir, stdio: "pipe" });
        await fs.writeFile(path.join(seedDir, "README.md"), "hello");
        execSync("git add README.md && git commit -m 'init'", { cwd: seedDir, stdio: "pipe", shell: "/bin/sh" });
        execSync("git push origin HEAD:main", { cwd: seedDir, stdio: "pipe" });
      } finally {
        await fs.rm(seedDir, { recursive: true, force: true });
      }

      const companyId = "co_sync_test";
      const { workdir, state } = await syncWorkspace(companyId, remoteDir, "main");

      expect(workdir).toContain(companyId);
      expect(state.repoUrl).toBe(remoteDir);
      expect(state.companyId).toBe(companyId);
      expect(state.headSha).toMatch(/^[0-9a-f]{40}$/);

      // State should be persisted
      const loaded = await loadWorkspaceState(companyId);
      expect(loaded?.headSha).toBe(state.headSha);
    } finally {
      await fs.rm(remoteDir, { recursive: true, force: true });
    }
  });

  it("fetches instead of re-cloning on second call with same repoUrl", async () => {
    const remoteDir = await fs.mkdtemp(path.join(os.tmpdir(), "trent-remote2-"));
    const { execSync } = await import("child_process");

    try {
      execSync("git init --bare .", { cwd: remoteDir, stdio: "pipe" });
      const seedDir = await fs.mkdtemp(path.join(os.tmpdir(), "trent-seed2-"));
      try {
        execSync(`git clone ${remoteDir} .`, { cwd: seedDir, stdio: "pipe" });
        execSync("git config user.email 'test@test.com'", { cwd: seedDir, stdio: "pipe" });
        execSync("git config user.name 'Test'", { cwd: seedDir, stdio: "pipe" });
        await fs.writeFile(path.join(seedDir, "README.md"), "hello");
        execSync("git add README.md && git commit -m 'init'", { cwd: seedDir, stdio: "pipe", shell: "/bin/sh" });
        execSync("git push origin HEAD:main", { cwd: seedDir, stdio: "pipe" });
      } finally {
        await fs.rm(seedDir, { recursive: true, force: true });
      }

      const companyId = "co_fetch_test";
      const { state: s1 } = await syncWorkspace(companyId, remoteDir, "main");
      const { state: s2 } = await syncWorkspace(companyId, remoteDir, "main");

      // clonedAt must be the same; lastSyncedAt may differ
      expect(s2.clonedAt).toBe(s1.clonedAt);
      expect(s2.headSha).toBe(s1.headSha);
    } finally {
      await fs.rm(remoteDir, { recursive: true, force: true });
    }
  });
});

export {};
