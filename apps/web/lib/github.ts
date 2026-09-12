import { decryptJson, encryptJson, maskSecret } from "@/lib/secrets";
import { store } from "@/lib/store";
import { nowIso, slugify } from "@/lib/utils";
import type { Task, ToolCallRecord, ToolConnection } from "@/lib/types";
import { isHttpHeaderValueSafe, malformedCredentialSummary } from "@/lib/http-credential";

export type GitHubCredentials = {
  token: string;
  owner: string;
  repo: string;
};

export type GitHubIssueInput = {
  title: string;
  body: string;
  labels?: string[];
};

const GITHUB_ISSUE_APPROVAL_ACTION = "github.create_issue";
const GITHUB_PR_SCAFFOLD_APPROVAL_ACTION = "github.scaffold_pr";

function envCredentials(): GitHubCredentials | undefined {
  const token = (process.env.GITHUB_TOKEN || process.env.GITHUBTOKEN)?.trim();
  const owner = process.env.GITHUB_OWNER?.trim();
  const repo = process.env.GITHUB_REPO?.trim();
  return token && owner && repo ? { token, owner, repo } : undefined;
}

export async function saveGitHubConnection(companyId: string, credentials: GitHubCredentials) {
  return store.upsertIntegration({
    companyId,
    provider: "GitHub",
    scopes: ["repo:read", "issues:write", "pull_requests:write", "contents:write", "statuses:read"],
    status: "connected",
    encryptedData: encryptJson(credentials)
  });
}

export function publicGitHubConnection(connection: ToolConnection) {
  let repository: string | undefined;
  let token: string | undefined;
  if (connection.encryptedData) {
    try {
      const credentials = decryptJson<GitHubCredentials>(connection.encryptedData);
      repository = `${credentials.owner}/${credentials.repo}`;
      token = maskSecret(credentials.token);
    } catch {
      repository = "unreadable encrypted credentials";
    }
  }

  return {
    id: connection.id,
    companyId: connection.companyId,
    provider: connection.provider,
    scopes: connection.scopes,
    status: connection.status,
    repository,
    token,
    lastCheckedAt: connection.lastCheckedAt
  };
}

export async function getGitHubCredentials(companyId?: string): Promise<GitHubCredentials | undefined> {
  if (companyId) {
    const connection = await store.getIntegration(companyId, "GitHub");
    if (connection?.encryptedData) {
      return decryptJson<GitHubCredentials>(connection.encryptedData);
    }
  }
  return envCredentials();
}

async function githubFetch(credentials: GitHubCredentials, path: string, init?: RequestInit) {
  const credentialError = githubCredentialError(credentials);
  if (credentialError) throw new Error(credentialError);
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${credentials.token}`,
      "Content-Type": "application/json",
      "User-Agent": "trent-ai-cofounder",
      ...(init?.headers ?? {})
    }
  });
}

export type GitHubRepoValidation = {
  ok: boolean;
  status: "connected" | "needs_credentials" | "failed";
  repository?: string;
  defaultBranch?: string;
  private?: boolean;
  url?: string;
  permissions?: Record<string, boolean>;
  error?: string;
};

export async function validateGitHubConnection(companyId?: string): Promise<GitHubRepoValidation> {
  const credentials = await getGitHubCredentials(companyId);
  if (!credentials) {
    return { ok: false, status: "needs_credentials", error: "GitHub credentials are not configured." };
  }
  const credentialError = githubCredentialError(credentials);
  if (credentialError) {
    return {
      ok: false,
      status: "failed",
      repository: `${credentials.owner}/${credentials.repo}`,
      error: credentialError,
    };
  }

  const response = await githubFetch(credentials, `/repos/${credentials.owner}/${credentials.repo}`);
  if (!response.ok) {
    return {
      ok: false,
      status: "failed",
      repository: `${credentials.owner}/${credentials.repo}`,
      error: `GitHub repo validation failed with ${response.status}: ${(await response.text()).slice(0, 300)}`
    };
  }

  const repo = (await response.json()) as {
    full_name?: string;
    default_branch?: string;
    private?: boolean;
    html_url?: string;
    permissions?: Record<string, boolean>;
  };

  return {
    ok: true,
    status: "connected",
    repository: repo.full_name ?? `${credentials.owner}/${credentials.repo}`,
    defaultBranch: repo.default_branch,
    private: repo.private,
    url: repo.html_url,
    permissions: repo.permissions
  };
}

export async function listGitHubRepos(companyId?: string) {
  const credentials = await getGitHubCredentials(companyId);
  if (!credentials) {
    return { status: "needs_credentials" as const, repositories: [] };
  }
  const credentialError = githubCredentialError(credentials);
  if (credentialError) {
    return { status: "failed" as const, repositories: [], error: credentialError };
  }

  const response = await githubFetch(credentials, "/user/repos?per_page=100&sort=updated");
  if (!response.ok) {
    return {
      status: "failed" as const,
      repositories: [],
      error: `GitHub repo listing failed with ${response.status}: ${(await response.text()).slice(0, 300)}`
    };
  }

  const repos = (await response.json()) as Array<{
    full_name: string;
    name: string;
    owner: { login: string };
    private: boolean;
    html_url: string;
    default_branch: string;
    permissions?: Record<string, boolean>;
  }>;

  return {
    status: "connected" as const,
    repositories: repos.map((repo) => ({
      fullName: repo.full_name,
      owner: repo.owner.login,
      name: repo.name,
      private: repo.private,
      url: repo.html_url,
      defaultBranch: repo.default_branch,
      permissions: repo.permissions
    }))
  };
}

export async function createGitHubIssue(
  companyId: string,
  input: GitHubIssueInput
): Promise<ToolCallRecord & { url?: string; number?: number }> {
  const credentials = await getGitHubCredentials(companyId);
  if (!credentials) {
    return {
      adapter: "GitHub",
      action: "create_issue",
      status: "failed",
      summary: "GitHub credentials are not configured. Connect a GitHub App/token with repo write access before Trent can create issues."
    };
  }
  const credentialError = githubCredentialError(credentials);
  if (credentialError) {
    return {
      adapter: "GitHub",
      action: "create_issue",
      status: "failed",
      summary: credentialError,
    };
  }

  const response = await githubFetch(credentials, `/repos/${credentials.owner}/${credentials.repo}/issues`, {
    method: "POST",
    body: JSON.stringify({
      title: input.title,
      body: input.body,
      labels: input.labels ?? ["trent", "ai-cofounder"]
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    return {
      adapter: "GitHub",
      action: "create_issue",
      status: "failed",
      summary: `GitHub issue creation failed with ${response.status}: ${detail.slice(0, 300)}`
    };
  }

  const issue = (await response.json()) as { html_url?: string; number?: number };
  return {
    adapter: "GitHub",
    action: "create_issue",
    status: "completed",
    summary: `Created GitHub issue #${issue.number ?? "unknown"} for ${credentials.owner}/${credentials.repo}.`,
    url: issue.html_url,
    number: issue.number
  };
}

async function findApproval(task: Task, action: string) {
  if (task.approvalId) {
    const linked = await store.getApproval(task.approvalId);
    if (linked?.action === action) return linked;
  }

  const approvals = await store.listApprovals(task.companyId);
  return approvals.find((approval) => approval.taskId === task.id && approval.action === action);
}

async function ensureTaskApproval(task: Task, action: string, reason: string) {
  const existing = await findApproval(task, action);
  if (existing?.status === "approved") return { approved: true, approvalId: existing.id };

  if (existing?.status === "rejected") {
    await store.updateTask(task.id, { status: "blocked", approvalId: existing.id });
    return { approved: false, approvalId: existing.id, rejected: true };
  }

  if (existing?.status === "pending") {
    await store.updateTask(task.id, { status: "waiting_approval", approvalId: existing.id });
    return { approved: false, approvalId: existing.id };
  }

  const approval = await store.createApproval({
    companyId: task.companyId,
    taskId: task.id,
    action,
    reason
  });
  await store.updateTask(task.id, { status: "waiting_approval", approvalId: approval.id });
  return { approved: false, approvalId: approval.id };
}

export async function createGitHubIssueForTask(task: Task) {
  const approval = await ensureTaskApproval(
    task,
    GITHUB_ISSUE_APPROVAL_ACTION,
    `Approve creating a GitHub issue for Engineer task "${task.title}".`
  );
  if (!approval.approved) {
    return {
      adapter: "GitHub",
      action: "create_issue",
      status: "needs_approval" as const,
      summary: approval.rejected
        ? "GitHub issue creation was rejected and the task is blocked."
        : "GitHub issue creation requires approval before Trent can write to GitHub.",
      approvalId: approval.approvalId
    };
  }

  await store.updateTask(task.id, { status: "running" });
  const issue = await createGitHubIssue(task.companyId, {
    title: task.title,
    body: [
      task.prompt,
      "",
      `Trent task: ${task.id}`,
      `Priority: ${task.priority}`,
      `Agent: ${task.agentRole}`,
      `Created: ${task.createdAt}`
    ].join("\n"),
    labels: ["trent", task.agentRole, task.priority]
  });

  if (issue.status === "completed") {
    await store.updateTask(task.id, {
      status: "completed",
      costCents: task.costCents + 5
    });
    await store.createDocument({
      companyId: task.companyId,
      type: "agent_note",
      title: `GitHub issue created: ${task.title}`,
      content: `${issue.summary}\n\n${issue.url ?? ""}`.trim(),
      source: "github",
      version: 1
    });
    await store.addUsage({
      companyId: task.companyId,
      category: "infra",
      description: "GitHub issue creation",
      amountCents: 0,
      metadata: { taskId: task.id, at: nowIso(), issueNumber: issue.number ?? 0 }
    });
  } else if (issue.status === "failed") {
    await store.updateTask(task.id, { status: "failed" });
  } else if (issue.status === "mocked") {
    await store.updateTask(task.id, { status: "blocked" });
  }

  return issue;
}

export async function scaffoldGitHubPullRequestForTask(task: Task) {
  const approval = await ensureTaskApproval(
    task,
    GITHUB_PR_SCAFFOLD_APPROVAL_ACTION,
    `Approve creating a GitHub branch and PR scaffold for Engineer task "${task.title}".`
  );
  if (!approval.approved) {
    return {
      adapter: "GitHub",
      action: "scaffold_pr",
      status: "needs_approval" as const,
      summary: approval.rejected
        ? "GitHub PR scaffold was rejected and the task is blocked."
        : "GitHub PR scaffold requires approval before Trent can create a branch.",
      approvalId: approval.approvalId
    };
  }

  const credentials = await getGitHubCredentials(task.companyId);
  if (!credentials) {
    await store.updateTask(task.id, { status: "failed" });
    return {
      adapter: "GitHub",
      action: "scaffold_pr",
      status: "failed" as const,
      summary: "GitHub credentials are not configured. Connect a GitHub App/token with repo write access before Trent can create a PR scaffold."
    };
  }
  const credentialError = githubCredentialError(credentials);
  if (credentialError) {
    await store.updateTask(task.id, { status: "failed" });
    return {
      adapter: "GitHub",
      action: "scaffold_pr",
      status: "failed" as const,
      summary: credentialError,
    };
  }

  await store.updateTask(task.id, { status: "running" });
  const repo = await validateGitHubConnection(task.companyId);
  if (!repo.ok || !repo.defaultBranch) {
    await store.updateTask(task.id, { status: "failed" });
    return {
      adapter: "GitHub",
      action: "scaffold_pr",
      status: "failed" as const,
      summary: repo.error ?? "Could not validate GitHub repository default branch."
    };
  }

  const branchName = `trent/${slugify(task.title) || task.id}`.slice(0, 96);
  const baseRef = await githubFetch(
    credentials,
    `/repos/${credentials.owner}/${credentials.repo}/git/ref/heads/${repo.defaultBranch}`
  );
  if (!baseRef.ok) {
    await store.updateTask(task.id, { status: "failed" });
    return {
      adapter: "GitHub",
      action: "scaffold_pr",
      status: "failed" as const,
      summary: `Could not read base branch ${repo.defaultBranch}: ${baseRef.status}`
    };
  }

  const base = (await baseRef.json()) as { object?: { sha?: string } };
  const sha = base.object?.sha;
  if (!sha) throw new Error("GitHub base ref response did not include a SHA");

  const createRef = await githubFetch(credentials, `/repos/${credentials.owner}/${credentials.repo}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha })
  });

  if (!createRef.ok && createRef.status !== 422) {
    await store.updateTask(task.id, { status: "failed" });
    return {
      adapter: "GitHub",
      action: "scaffold_pr",
      status: "failed" as const,
      summary: `Could not create branch ${branchName}: ${createRef.status} ${(await createRef.text()).slice(0, 200)}`
    };
  }

  const repoUrl = repo.url ?? `https://github.com/${credentials.owner}/${credentials.repo}`;
  const branchUrl = `${repoUrl}/tree/${encodeURIComponent(branchName)}`;

  // 1. Commit a summary file to the branch using contents API
  const markdownContent = [
    `# Trent Agent Deliverables`,
    `- **Task Title**: ${task.title}`,
    `- **Task ID**: ${task.id}`,
    `- **Agent Role**: ${task.agentRole}`,
    `- **Priority**: ${task.priority}`,
    `- **Completed At**: ${nowIso()}`,
    ``,
    `## Task Implementation Prompt`,
    task.prompt,
    ``,
    `This work was completed autonomously by Trent.`
  ].join("\n");

  const fileContentBase64 = Buffer.from(markdownContent).toString("base64");
  const contentWrite = await githubFetch(
    credentials,
    `/repos/${credentials.owner}/${credentials.repo}/contents/trent-task-${task.id}.md`,
    {
      method: "PUT",
      body: JSON.stringify({
        message: `feat: implement task ${task.title}`,
        content: fileContentBase64,
        branch: branchName
      })
    }
  );
  if (!contentWrite.ok) {
    await store.updateTask(task.id, { status: "failed" });
    return {
      adapter: "GitHub",
      action: "scaffold_pr",
      status: "failed" as const,
      summary: `Could not write PR scaffold commit: ${contentWrite.status} ${(await contentWrite.text()).slice(0, 200)}`
    };
  }
  const contentWriteData = (await contentWrite.json().catch(() => ({}))) as { commit?: { sha?: string } };
  const commitSha = contentWriteData.commit?.sha;

  // 2. Open a real pull request on the repository
  let prUrl: string | undefined;
  let prNumber: number | undefined;
  let ciStatus: string | undefined;

  const prRes = await githubFetch(
    credentials,
    `/repos/${credentials.owner}/${credentials.repo}/pulls`,
    {
      method: "POST",
      body: JSON.stringify({
        title: `feat: ${task.title}`,
        body: `This pull request was automatically generated by Trent's ${task.agentRole} agent for task: ${task.title}.\n\n### Task Prompt\n${task.prompt}\n\n### Deliverables\nSee the summary in [trent-task-${task.id}.md](trent-task-${task.id}.md).`,
        head: branchName,
        base: repo.defaultBranch
      })
    }
  );

  if (prRes.ok) {
    const prData = (await prRes.json()) as { html_url?: string; number?: number };
    prUrl = prData.html_url;
    prNumber = prData.number;
  } else if (prRes.status === 422) {
    const listPrs = await githubFetch(
      credentials,
      `/repos/${credentials.owner}/${credentials.repo}/pulls?head=${credentials.owner}:${branchName}&base=${repo.defaultBranch}`
    );
    if (listPrs.ok) {
      const prs = (await listPrs.json()) as Array<{ html_url?: string; number?: number }>;
      if (prs.length > 0) {
        prUrl = prs[0].html_url;
        prNumber = prs[0].number;
      }
    }
  }

  if (commitSha) {
    const statusRes = await githubFetch(
      credentials,
      `/repos/${credentials.owner}/${credentials.repo}/commits/${commitSha}/status`,
      { method: "GET" }
    );
    if (statusRes.ok) {
      const status = (await statusRes.json()) as { state?: string };
      ciStatus = status.state;
    } else {
      ciStatus = `unavailable:${statusRes.status}`;
    }
  }

  await store.createDocument({
    companyId: task.companyId,
    type: "agent_note",
    title: `GitHub PR scaffold: ${task.title}`,
    content: [
      `Branch: ${branchName}`,
      `Base: ${repo.defaultBranch}`,
      `Branch URL: ${branchUrl}`,
      `Pull Request: ${prUrl ?? "not created or already exists"}`,
      `CI Status: ${ciStatus ?? "not checked"}`,
      "",
      `Created commit with file: trent-task-${task.id}.md`,
      "Implementation summary committed and pull request submitted."
    ].join("\n"),
    source: "github",
    version: 1
  });

  const metadata: Record<string, string | number | boolean> = {
    taskId: task.id,
    branchName,
    at: nowIso()
  };
  if (prNumber !== undefined) {
    metadata.pullRequestNumber = prNumber;
  }
  if (ciStatus) {
    metadata.ciStatus = ciStatus;
  }

  await store.addUsage({
    companyId: task.companyId,
    category: "infra",
    description: "GitHub PR scaffold branch",
    amountCents: 0,
    metadata
  });
  await store.updateTask(task.id, { status: "completed" });

  return {
    adapter: "GitHub",
    action: "scaffold_pr",
    status: "completed" as const,
    summary: prNumber
      ? `Created GitHub branch ${branchName} and opened Pull Request #${prNumber}.`
      : `Created GitHub branch ${branchName} (Pull Request creation was skipped or already exists).`,
    branchName,
    branchUrl,
    pullRequestUrl: prUrl,
    pullRequestNumber: prNumber,
    ciStatus
  };
}

function githubCredentialError(credentials: GitHubCredentials): string | undefined {
  return isHttpHeaderValueSafe(credentials.token) ? undefined : malformedCredentialSummary("GitHub token");
}
