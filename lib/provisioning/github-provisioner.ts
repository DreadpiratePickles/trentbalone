/**
 * lib/provisioning/github-provisioner.ts
 *
 * Provisions a GitHub repository per company on the Trent platform org.
 *
 * Steps:
 *   1. createRepo    — creates the repo in the platform org
 *   2. setBranchProtection — locks the default branch
 *   3. installApp    — installs the GitHub App so workbench sessions can check out the repo
 *
 * Rollback contract:
 *   If any step after createRepo fails, deleteRepo is called before re-throwing.
 *   If createRepo itself fails, nothing is cleaned up.
 *
 * Idempotency:
 *   provision() reads store.getIntegration(companyId, "GitHub-Provisioned") first.
 *   If a record already exists, the stored resource is returned with zero API calls.
 *
 * Credential boundary:
 *   GITHUB_APP_PRIVATE_KEY is read from process.env and used only to build JWTs
 *   inside the real API client. It MUST NOT appear in any error message, log line,
 *   or integration record stored in the DB.
 *
 * Production use:
 *   const client = createGitHubApiClient();
 *   const resource = await provision({ companyId, companySlug }, client);
 *
 * Testing:
 *   Pass a mock GitHubApiClient — the provisioner has no direct dependency on
 *   the real HTTP client, making every code path testable without network access.
 */

import { store } from "@/lib/store";
import { encryptJson, decryptJson } from "@/lib/secrets";
import { appendAuditLog } from "@/lib/audit-log";

// ── Public types ──────────────────────────────────────────────────────────────

export type GitHubProvisionedResource = {
  /** Full HTTPS clone URL, e.g. https://github.com/trent-platform/acme-co */
  repoUrl: string;
  /** owner/repo slug, e.g. trent-platform/acme-co */
  repoFullName: string;
  /** Default branch name (always "main" for new repos) */
  defaultBranch: string;
  /** GitHub App installation ID for this repo (enables workbench checkout) */
  installationId?: number;
};

export type GitHubProvisionInput = {
  companyId: string;
  /** URL-safe slug used to derive the repo name, e.g. "acme-co" */
  companySlug: string;
  description?: string;
};

export type GitHubRollbackInput = {
  companyId: string;
  /** owner/repo slug of the repo to delete */
  repoFullName: string;
};

// ── API client interface ──────────────────────────────────────────────────────

/**
 * Thin interface over the GitHub REST API.
 * The real implementation uses fetch + GitHub App JWT auth.
 * Tests inject a mock implementation.
 *
 * Implementations MUST NOT include GITHUB_APP_PRIVATE_KEY in error messages.
 */
export interface GitHubApiClient {
  createRepo(input: {
    org: string;
    name: string;
    description?: string;
    private?: boolean;
  }): Promise<{ repoUrl: string; repoFullName: string; defaultBranch: string }>;

  setBranchProtection(input: {
    repoFullName: string;
    branch: string;
  }): Promise<void>;

  installApp(input: {
    repoFullName: string;
  }): Promise<{ installationId: number }>;

  deleteRepo(repoFullName: string): Promise<void>;
}

// ── Integration record key ────────────────────────────────────────────────────

const PROVIDER_KEY = "GitHub-Provisioned";

// ── Platform config helpers ───────────────────────────────────────────────────

function getPlatformOrg(): string {
  return process.env.GITHUB_PLATFORM_ORG ?? "trent-platform";
}

// ── Real API client (production) ──────────────────────────────────────────────

/**
 * Returns a production GitHubApiClient that authenticates via GitHub App JWT.
 * The private key is read from GITHUB_APP_PRIVATE_KEY env var inside each call
 * and is never stored or propagated to caller context.
 *
 * NOTE: Uses Node 18+ native fetch. Import this only in server-side code.
 */
export function createGitHubApiClient(): GitHubApiClient {
  function getAppId(): string {
    const id = process.env.GITHUB_APP_ID;
    if (!id) throw new Error("GITHUB_APP_ID env var is required");
    return id;
  }

  function getInstallationId(): number {
    const id = parseInt(process.env.GITHUB_APP_INSTALLATION_ID ?? "", 10);
    if (!id) throw new Error("GITHUB_APP_INSTALLATION_ID env var is required");
    return id;
  }

  async function getInstallationToken(): Promise<string> {
    // In production: sign a JWT with the App private key, exchange for installation token.
    // The raw key material is used only inside this scope and never returned or logged.
    const appId = getAppId();
    const installationId = getInstallationId();

    // Build App JWT (RS256)
    const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
    if (!privateKey) throw new Error("GITHUB_APP_PRIVATE_KEY env var is required");

    // Encode the JWT header + payload
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId })).toString("base64url");

    const { createSign } = await import("node:crypto");
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${payload}`);
    const sig = signer.sign(privateKey, "base64url");
    const jwt = `${header}.${payload}.${sig}`;

    // Exchange for installation token
    const res = await fetch(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );

    if (!res.ok) {
      // Do NOT include the JWT or private key in the error message
      throw new Error(`GitHub App token exchange failed: HTTP ${res.status}`);
    }

    const data = await res.json() as { token: string };
    return data.token;
  }

  async function ghFetch(path: string, options: RequestInit = {}): Promise<Response> {
    const token = await getInstallationToken();
    return fetch(`https://api.github.com${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        ...(options.headers ?? {}),
      },
    });
  }

  return {
    async createRepo({ org, name, description, private: isPrivate = true }) {
      const res = await ghFetch(`/orgs/${org}/repos`, {
        method: "POST",
        body: JSON.stringify({ name, description: description ?? "", private: isPrivate, auto_init: true }),
      });
      if (!res.ok) {
        throw new Error(`createRepo failed: HTTP ${res.status}`);
      }
      const data = await res.json() as { html_url: string; full_name: string; default_branch: string };
      return { repoUrl: data.html_url, repoFullName: data.full_name, defaultBranch: data.default_branch };
    },

    async setBranchProtection({ repoFullName, branch }) {
      const [owner, repo] = repoFullName.split("/");
      const res = await ghFetch(`/repos/${owner}/${repo}/branches/${branch}/protection`, {
        method: "PUT",
        body: JSON.stringify({
          required_status_checks: null,
          enforce_admins: false,
          required_pull_request_reviews: { required_approving_review_count: 1 },
          restrictions: null,
        }),
      });
      if (!res.ok) {
        throw new Error(`setBranchProtection failed: HTTP ${res.status}`);
      }
    },

    async installApp({ repoFullName }) {
      const installationId = getInstallationId();
      const [owner, repo] = repoFullName.split("/");
      const res = await ghFetch(`/user/installations/${installationId}/repositories`, {
        method: "PUT",
        body: JSON.stringify({ repository_ids: [], repository: `${owner}/${repo}` }),
      });
      if (!res.ok) {
        throw new Error(`installApp failed: HTTP ${res.status}`);
      }
      return { installationId };
    },

    async deleteRepo(repoFullName) {
      const [owner, repo] = repoFullName.split("/");
      const res = await ghFetch(`/repos/${owner}/${repo}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) {
        throw new Error(`deleteRepo failed: HTTP ${res.status}`);
      }
    },
  };
}

// ── Store helpers ─────────────────────────────────────────────────────────────

async function loadResource(companyId: string): Promise<GitHubProvisionedResource | null> {
  const integration = await store.getIntegration(companyId, PROVIDER_KEY);
  if (!integration?.encryptedData) return null;
  try {
    return decryptJson<GitHubProvisionedResource>(integration.encryptedData);
  } catch {
    return null;
  }
}

async function saveResource(companyId: string, resource: GitHubProvisionedResource): Promise<void> {
  await store.upsertIntegration({
    companyId,
    provider: PROVIDER_KEY,
    scopes: ["repo"],
    status: "connected",
    encryptedData: encryptJson(resource),
  });
}

async function removeResource(companyId: string): Promise<void> {
  const integration = await store.getIntegration(companyId, PROVIDER_KEY);
  if (integration) {
    await store.revokeIntegration(integration.id);
  }
}

// ── provision() ───────────────────────────────────────────────────────────────

/**
 * Provision a GitHub repo for the given company.
 *
 * Idempotent — if a record already exists, returns it without any API calls.
 * Rollback — if any post-creation step fails, the repo is deleted before throwing.
 */
export async function provision(
  input: GitHubProvisionInput,
  client: GitHubApiClient
): Promise<GitHubProvisionedResource> {
  const { companyId, companySlug, description } = input;

  // ── Idempotency check ────────────────────────────────────────────────────
  const existing = await loadResource(companyId);
  if (existing) return existing;

  const org = getPlatformOrg();
  let repoFullName: string | undefined;

  // ── Step 1: Create repo ─────────────────────────────────────────────────
  let created: { repoUrl: string; repoFullName: string; defaultBranch: string };
  try {
    created = await client.createRepo({
      org,
      name: companySlug,
      description,
      private: true,
    });
    repoFullName = created.repoFullName;
  } catch (err: unknown) {
    throw sanitizeError(err, "repo.create");
  }

  // ── Steps 2–3 with rollback on failure ───────────────────────────────────
  try {
    // Step 2: Set branch protection
    await client.setBranchProtection({
      repoFullName: created.repoFullName,
      branch: created.defaultBranch,
    });

    // Step 3: Install GitHub App
    const { installationId } = await client.installApp({
      repoFullName: created.repoFullName,
    });

    // ── Persist ─────────────────────────────────────────────────────────────
    const resource: GitHubProvisionedResource = {
      repoUrl: created.repoUrl,
      repoFullName: created.repoFullName,
      defaultBranch: created.defaultBranch,
      installationId,
    };

    await saveResource(companyId, resource);

    await appendAuditLog(
      companyId,
      "system",
      "repo.provision",
      "github_repo",
      created.repoFullName,
      `Provisioned GitHub repo ${created.repoFullName}`
    );

    return resource;
  } catch (err: unknown) {
    // Rollback: delete the repo to avoid orphaned resource
    if (repoFullName) {
      try {
        await client.deleteRepo(repoFullName);
      } catch {
        // Best-effort cleanup — do not throw a second error
      }
    }
    throw sanitizeError(err, "repo.provision");
  }
}

// ── rollback() ────────────────────────────────────────────────────────────────

/**
 * Tear down a provisioned GitHub repo.
 * Safe to call when no integration record exists — returns without error.
 */
export async function rollback(
  input: GitHubRollbackInput,
  client: GitHubApiClient
): Promise<void> {
  const { companyId, repoFullName } = input;

  const integration = await store.getIntegration(companyId, PROVIDER_KEY);
  if (!integration) return; // nothing to clean up

  try {
    await client.deleteRepo(repoFullName);
  } catch (err: unknown) {
    throw sanitizeError(err, "repo.rollback");
  }

  await removeResource(companyId);

  await appendAuditLog(
    companyId,
    "system",
    "repo.rollback",
    "github_repo",
    repoFullName,
    `Rolled back GitHub repo ${repoFullName}`
  );
}

// ── getStatus() ───────────────────────────────────────────────────────────────

/**
 * Returns the provisioned resource for a company, or null if not provisioned.
 */
export async function getStatus(companyId: string): Promise<GitHubProvisionedResource | null> {
  return loadResource(companyId);
}

// ── Credential scrubbing ──────────────────────────────────────────────────────

/**
 * Wrap errors to prevent private key material from propagating in error messages.
 * Any error that contains multi-line PEM blocks or base64 key material is replaced
 * with a sanitized version that preserves the error kind but drops key content.
 */
function sanitizeError(err: unknown, context: string): Error {
  const raw = err instanceof Error ? err.message : String(err);

  // Strip PEM blocks — any "-----BEGIN ... KEY-----...-----END ... KEY-----" sequences
  const PEM_PATTERN = /-----BEGIN[A-Z\s]+-----[\s\S]*?-----END[A-Z\s]+-----/g;
  // Strip long base64 lines that could be key fragments (40+ chars of base64)
  const BASE64_BLOCK = /[A-Za-z0-9+/]{40,}={0,2}/g;

  const sanitized = raw
    .replace(PEM_PATTERN, "[KEY_MATERIAL_REDACTED]")
    .replace(BASE64_BLOCK, "[REDACTED]");

  return new Error(`[${context}] ${sanitized}`);
}
