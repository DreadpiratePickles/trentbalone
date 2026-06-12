import { describe, it, expect, beforeEach } from "vitest";
import { store } from "./store";
import { 
  getGitProviderFromUrl, 
  getGitUserForProvider, 
  resolveGitCredentials,
  GitCredentialsNotFoundError,
  setupSandboxGitAuth,
  checkoutRepository
} from "./git-checkout";
import { saveGitHubConnection } from "./github";
import type { WorkbenchProviderAdapter } from "./workbench-provider";
import type { WorkbenchSession } from "./types";

let companyId = "c_test";

beforeEach(async () => {
  await (store as any).clearAll?.();
  const company = await store.createCompany({
    name: `Git Checkout ${Math.random().toString(36).slice(2)}`,
    brief: { vision: "test" },
  });
  companyId = company.id;
});

describe("git-checkout provider routing and credentials", () => {
  it("parses provider from URL", () => {
    expect(getGitProviderFromUrl("https://github.com/owner/repo.git")).toBe("GitHub");
    expect(getGitProviderFromUrl("git@gitlab.com:owner/repo")).toBe("GitLab");
    expect(getGitProviderFromUrl("https://bitbucket.org/owner/repo")).toBe("Bitbucket");
    expect(getGitProviderFromUrl("https://other.com/owner/repo")).toBeUndefined();
  });

  it("maps providers to checkout usernames", () => {
    expect(getGitUserForProvider("GitHub")).toBe("x-access-token");
    expect(getGitUserForProvider("GitLab")).toBe("oauth2");
    expect(getGitUserForProvider("Bitbucket")).toBe("x-token-auth");
  });

  it("throws GitCredentialsNotFoundError when credentials are missing", async () => {
    await expect(resolveGitCredentials(companyId, "GitHub")).rejects.toThrow(
      GitCredentialsNotFoundError
    );
  });

  it("resolves token when integration exists", async () => {
    await saveGitHubConnection(companyId, {
      token: "ghp_mock_token",
      owner: "test-owner",
      repo: "test-repo"
    });
    const creds = await resolveGitCredentials(companyId, "GitHub");
    expect(creds.username).toBe("x-access-token");
    expect(creds.token).toBe("ghp_mock_token");
  });
});

describe("git-checkout orchestration", () => {
  let mockAdapter: WorkbenchProviderAdapter;
  let mockSession: WorkbenchSession;
  let writtenFiles: Record<string, string> = {};
  let executedCommands: string[] = [];
  let injectedEnvs: Record<string, string>[] = [];

  beforeEach(() => {
    writtenFiles = {};
    executedCommands = [];
    injectedEnvs = [];

    mockSession = {
      id: "session_123",
      companyId: companyId,
      agentRole: "engineer",
      agentMode: "build",
      messageCount: 0,
      status: "running",
      provider: "mock_local",
      objective: "Checkout repository",
      repoUrl: "https://github.com/owner/repo.git",
      createdAt: "",
      updatedAt: "",
      costCents: 0,
      metadata: {
        networkPolicy: "allowlist",
        allowedHosts: [],
        maxRuntimeSeconds: 600,
        maxCostCents: 200,
        approvalRequiredFor: [],
        rollbackAvailable: false
      }
    };

    mockAdapter = {
      name: "mock_adapter",
      start: async () => {},
      stop: async () => {},
      exec: async (sess, cmd, opts) => {
        executedCommands.push(cmd);
        if (opts?.env) injectedEnvs.push(opts.env);
        return { stdout: "", stderr: "", exitCode: 0, durationMs: 1 };
      },
      readFile: async () => "",
      writeFile: async (sess, path, content) => {
        writtenFiles[path] = content;
      },
      listFiles: async () => [],
      runTests: async () => ({ passed: 1, failed: 0, skipped: 0, durationMs: 1, output: "", exitCode: 0 }),
      screenshot: async () => ({ dataUri: "", width: 1, height: 1, storageKey: "" }),
      getPreviewUrl: async () => "",
      captureArtifact: async () => ({} as any)
    };
  });

  it("writes /tmp/git-askpass.sh and configures git credentials username", async () => {
    await saveGitHubConnection(companyId, {
      token: "ghp_mock_token",
      owner: "test-owner",
      repo: "test-repo"
    });

    const envs = await setupSandboxGitAuth(mockSession, mockAdapter);

    expect(writtenFiles["/tmp/git-askpass.sh"]).toContain("*Username*) echo \"${GIT_USER:-git}\"");
    expect(writtenFiles["/tmp/git-askpass.sh"]).toContain("*) echo \"$GIT_TOKEN\"");
    expect(executedCommands).toContain("chmod +x /tmp/git-askpass.sh");
    expect(executedCommands).toContain("git config --global credential.username x-access-token");
    expect(envs.GIT_TOKEN).toBe("ghp_mock_token");
    expect(envs.GIT_ASKPASS).toBe("/tmp/git-askpass.sh");
    expect(envs.GIT_TERMINAL_PROMPT).toBe("0");
    expect(envs.GIT_USER).toBe("x-access-token");
  });

  it("runs git clone with secure askpass environment variables", async () => {
    await saveGitHubConnection(companyId, {
      token: "ghp_mock_token",
      owner: "test-owner",
      repo: "test-repo"
    });

    await checkoutRepository(mockSession, mockAdapter, "feature-branch");

    expect(executedCommands).toContain("git clone https://github.com/owner/repo.git .");
    expect(executedCommands).toContain("git checkout feature-branch");
    expect(injectedEnvs[0]?.GIT_TOKEN).toBe("ghp_mock_token");
    expect(injectedEnvs[0]?.GIT_ASKPASS).toBe("/tmp/git-askpass.sh");
    expect(injectedEnvs[0]?.GIT_TERMINAL_PROMPT).toBe("0");
    expect(injectedEnvs[0]?.GIT_USER).toBe("x-access-token");
  });

  it("fails setup immediately when the askpass helper cannot be made executable", async () => {
    await saveGitHubConnection(companyId, {
      token: "ghp_mock_token",
      owner: "test-owner",
      repo: "test-repo"
    });
    mockAdapter.exec = async (sess, cmd) => {
      executedCommands.push(cmd);
      if (cmd === "chmod +x /tmp/git-askpass.sh") {
        return { stdout: "", stderr: "chmod blocked", exitCode: 126, durationMs: 1 };
      }
      return { stdout: "", stderr: "", exitCode: 0, durationMs: 1 };
    };

    await expect(setupSandboxGitAuth(mockSession, mockAdapter)).rejects.toThrow(
      "Could not make Git askpass helper executable: chmod blocked"
    );
  });

  it("allows public repository checkout without stored credentials", async () => {
    await checkoutRepository(mockSession, mockAdapter, "feature-branch");

    expect(executedCommands).toContain("git clone https://github.com/owner/repo.git .");
    expect(executedCommands).toContain("git checkout feature-branch");
    expect(injectedEnvs).toHaveLength(0);
  });

  it("falls back to git checkout -b when git checkout fails", async () => {
    await saveGitHubConnection(companyId, {
      token: "ghp_mock_token",
      owner: "test-owner",
      repo: "test-repo"
    });

    mockAdapter.exec = async (sess, cmd, opts) => {
      executedCommands.push(cmd);
      if (cmd === "git checkout feature-branch") {
        return { stdout: "", stderr: "branch not found", exitCode: 1, durationMs: 1 };
      }
      return { stdout: "", stderr: "", exitCode: 0, durationMs: 1 };
    };

    await checkoutRepository(mockSession, mockAdapter, "feature-branch");

    expect(executedCommands).toContain("git checkout feature-branch");
    expect(executedCommands).toContain("git checkout -b feature-branch");
  });

  it("throws error with fallback command stderr on fallback checkout failure", async () => {
    await saveGitHubConnection(companyId, {
      token: "ghp_mock_token",
      owner: "test-owner",
      repo: "test-repo"
    });

    mockAdapter.exec = async (sess, cmd, opts) => {
      executedCommands.push(cmd);
      if (cmd === "git checkout feature-branch") {
        return { stdout: "", stderr: "branch not found", exitCode: 1, durationMs: 1 };
      }
      if (cmd === "git checkout -b feature-branch") {
        return { stdout: "", stderr: "invalid branch name", exitCode: 1, durationMs: 1 };
      }
      return { stdout: "", stderr: "", exitCode: 0, durationMs: 1 };
    };

    await expect(checkoutRepository(mockSession, mockAdapter, "feature-branch")).rejects.toThrow(
      "Git checkout for branch feature-branch failed: invalid branch name"
    );
  });
});
