import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGitHubIssue,
  createGitHubIssueForTask,
  listGitHubRepos,
  publicGitHubConnection,
  saveGitHubConnection,
  scaffoldGitHubPullRequestForTask,
  validateGitHubConnection
} from "@/lib/github";
import { store } from "@/lib/store";

describe("GitHub integration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stores GitHub credentials encrypted and redacts public output", async () => {
    const [company] = await store.listCompanies();
    const connection = await saveGitHubConnection(company.id, {
      token: "ghp_1234567890abcdef",
      owner: "trent",
      repo: "app"
    });

    expect(connection.encryptedData).toBeDefined();
    expect(connection.encryptedData).not.toContain("ghp_1234567890abcdef");

    const safe = publicGitHubConnection(connection);
    expect(safe.repository).toBe("trent/app");
    expect(safe.token).toBe("ghp_...cdef");
    expect(JSON.stringify(safe)).not.toContain(connection.encryptedData ?? "");
  });

  it("creates a real GitHub issue for an approved engineer task", async () => {
    const [company] = await store.listCompanies();
    await saveGitHubConnection(company.id, {
      token: "ghp_1234567890abcdef",
      owner: "trent",
      repo: "app"
    });
    const task = await store.createTask({
      companyId: company.id,
      title: "Implement approval-gated GitHub issue creation",
      prompt: "Create the issue only after human approval.",
      status: "queued",
      priority: "high",
      agentRole: "engineer",
      tags: ["github"]
    });
    const approval = await store.createApproval({
      companyId: company.id,
      taskId: task.id,
      action: "github.create_issue",
      reason: "Approve GitHub issue creation."
    });
    await store.resolveApproval(approval.id, "approved");
    await store.updateTask(task.id, { approvalId: approval.id });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ number: 42, html_url: "https://github.com/trent/app/issues/42" })
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await createGitHubIssueForTask(task);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("Expected completed GitHub issue result");
    expect(result.number).toBe(42);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/trent/app/issues",
      expect.objectContaining({ method: "POST" })
    );
    expect((await store.getTask(task.id))?.status).toBe("completed");
  });

  it("creates an approval interrupt instead of writing to GitHub without approval", async () => {
    const [company] = await store.listCompanies();
    await saveGitHubConnection(company.id, {
      token: "ghp_1234567890abcdef",
      owner: "trent",
      repo: "app"
    });
    const task = await store.createTask({
      companyId: company.id,
      title: "Create a GitHub issue only after approval",
      prompt: "This should stop before external side effects.",
      status: "queued",
      priority: "medium",
      agentRole: "engineer",
      tags: ["github"]
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await createGitHubIssueForTask(task);
    const updated = await store.getTask(task.id);

    expect(result.status).toBe("needs_approval");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updated?.status).toBe("waiting_approval");
    expect(updated?.approvalId).toBeDefined();
  });

  it("fails GitHub issue creation when credentials are not configured", async () => {
    const company = await store.createCompany({
      name: "Missing GitHub Credentials Co",
      brief: { vision: "No fake GitHub writes" }
    });
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("GITHUB_OWNER", "");
    vi.stubEnv("GITHUB_REPO", "");

    const result = await createGitHubIssue(company.id, {
      title: "Create real issue",
      body: "This should not be mocked.",
    });

    expect(result.status).toBe("failed");
    expect(result.summary).toMatch(/credentials are not configured/i);
    expect(result.summary).not.toMatch(/mock/i);
  });

  it("validates configured repo and lists repos", async () => {
    const [company] = await store.listCompanies();
    await saveGitHubConnection(company.id, {
      token: "ghp_1234567890abcdef",
      owner: "trent",
      repo: "app"
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          full_name: "trent/app",
          default_branch: "main",
          private: true,
          html_url: "https://github.com/trent/app",
          permissions: { pull: true, push: true }
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            full_name: "trent/app",
            name: "app",
            owner: { login: "trent" },
            private: true,
            html_url: "https://github.com/trent/app",
            default_branch: "main",
            permissions: { pull: true, push: true }
          }
        ]
      });
    vi.stubGlobal("fetch", fetchMock);

    const validation = await validateGitHubConnection(company.id);
    const repos = await listGitHubRepos(company.id);

    expect(validation.status).toBe("connected");
    expect(validation.defaultBranch).toBe("main");
    expect(repos.repositories[0]?.fullName).toBe("trent/app");
  });

  it("creates an approval interrupt before PR scaffolding", async () => {
    const [company] = await store.listCompanies();
    const task = await store.createTask({
      companyId: company.id,
      title: "Scaffold a PR branch",
      prompt: "Create only after approval.",
      status: "queued",
      priority: "medium",
      agentRole: "engineer",
      tags: ["github"]
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await scaffoldGitHubPullRequestForTask(task);
    const updated = await store.getTask(task.id);

    expect(result.status).toBe("needs_approval");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updated?.status).toBe("waiting_approval");
    expect(updated?.approvalId).toBeDefined();
  });

  it("creates a branch and PR scaffold document after approval", async () => {
    const [company] = await store.listCompanies();
    await saveGitHubConnection(company.id, {
      token: "ghp_1234567890abcdef",
      owner: "trent",
      repo: "app"
    });
    const task = await store.createTask({
      companyId: company.id,
      title: "Build PR scaffold",
      prompt: "Create branch and PR plan.",
      status: "queued",
      priority: "high",
      agentRole: "engineer",
      tags: ["github"]
    });
    const approval = await store.createApproval({
      companyId: company.id,
      taskId: task.id,
      action: "github.scaffold_pr",
      reason: "Approve PR scaffold."
    });
    await store.resolveApproval(approval.id, "approved");
    await store.updateTask(task.id, { approvalId: approval.id });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          full_name: "trent/app",
          default_branch: "main",
          html_url: "https://github.com/trent/app"
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ object: { sha: "abc123" } })
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ ref: "refs/heads/trent/build-pr-scaffold" })
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({})
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          html_url: "https://github.com/trent/app/pull/1",
          number: 1
        })
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await scaffoldGitHubPullRequestForTask(task);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("Expected completed PR scaffold result");
    expect(result.pullRequestNumber).toBe(1);
    expect(result.pullRequestUrl).toBe("https://github.com/trent/app/pull/1");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/trent/app/git/refs",
      expect.objectContaining({ method: "POST" })
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/repos/trent/app/contents/trent-task-"),
      expect.objectContaining({ method: "PUT" })
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/trent/app/pulls",
      expect.objectContaining({ method: "POST" })
    );
    expect((await store.getTask(task.id))?.status).toBe("completed");
  });
});
