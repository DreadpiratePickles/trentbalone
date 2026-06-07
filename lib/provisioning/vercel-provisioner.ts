/**
 * lib/provisioning/vercel-provisioner.ts
 *
 * Provisions a Vercel project per company (primary hosting provider).
 * Render is the fallback — see render-provisioner.ts.
 *
 * Steps:
 *   1. createProject  — creates project in the platform Vercel team
 *   2. injectEnvVars  — injects per-company env vars (optional; skipped if none)
 *   3. addDeploymentWebhook — wires up deployment status webhook
 *
 * Rollback: any step-2/3 failure deletes the project before re-throwing.
 * Idempotency: reads store first; returns existing resource with zero API calls.
 * Credential boundary: VERCEL_TOKEN never stored or propagated in error messages.
 */

import { store } from "@/lib/store";
import { encryptJson, decryptJson } from "@/lib/secrets";
import { appendAuditLog } from "@/lib/audit-log";

// ── Public types ──────────────────────────────────────────────────────────────

export type VercelProvisionedResource = {
  projectId: string;
  projectName: string;
  deploymentUrl: string;
  teamId?: string;
};

export type VercelProvisionInput = {
  companyId: string;
  companySlug: string;
  /** Per-company env vars to inject at provision time (e.g. Neon connection string). */
  envVars?: Record<string, string>;
  /** Webhook URL for deployment status events. Defaults to Trent's internal endpoint. */
  webhookUrl?: string;
};

export type VercelRollbackInput = {
  companyId: string;
  projectId: string;
};

// ── API client interface ──────────────────────────────────────────────────────

export interface VercelApiClient {
  createProject(input: { name: string; teamId?: string; framework?: string }): Promise<VercelProvisionedResource>;
  injectEnvVars(input: { projectId: string; teamId?: string; envVars: Record<string, string> }): Promise<void>;
  addDeploymentWebhook(input: { projectId: string; teamId?: string; webhookUrl: string }): Promise<void>;
  deleteProject(projectId: string): Promise<void>;
}

// ── Real API client ───────────────────────────────────────────────────────────

export function createVercelApiClient(): VercelApiClient {
  function getToken(): string {
    const t = process.env.VERCEL_TOKEN;
    if (!t) throw new Error("VERCEL_TOKEN env var is required");
    return t;
  }
  function getTeamId(): string | undefined {
    return process.env.VERCEL_TEAM_ID;
  }

  async function vFetch(path: string, options: RequestInit = {}): Promise<Response> {
    return fetch(`https://api.vercel.com${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${getToken()}`,
        "Content-Type": "application/json",
        ...(options.headers ?? {}),
      },
    });
  }

  return {
    async createProject({ name, teamId, framework = "nextjs" }) {
      const qs = teamId ? `?teamId=${teamId}` : "";
      const res = await vFetch(`/v10/projects${qs}`, {
        method: "POST",
        body: JSON.stringify({ name, framework }),
      });
      if (!res.ok) throw new Error(`createProject failed: HTTP ${res.status}`);
      const data = await res.json() as { id: string; name: string; link?: { deployedAt?: number } };
      const tId = getTeamId();
      return {
        projectId: data.id,
        projectName: data.name,
        deploymentUrl: `https://${name}.vercel.app`,
        teamId: tId,
      };
    },

    async injectEnvVars({ projectId, teamId, envVars }) {
      const qs = teamId ? `?teamId=${teamId}` : "";
      const body = Object.entries(envVars).map(([key, value]) => ({
        key,
        value,
        type: "encrypted",
        target: ["production", "preview", "development"],
      }));
      const res = await vFetch(`/v10/projects/${projectId}/env${qs}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`injectEnvVars failed: HTTP ${res.status}`);
    },

    async addDeploymentWebhook({ projectId, teamId, webhookUrl }) {
      const qs = teamId ? `?teamId=${teamId}` : "";
      const res = await vFetch(`/v1/webhooks${qs}`, {
        method: "POST",
        body: JSON.stringify({ url: webhookUrl, events: ["deployment.created", "deployment.succeeded", "deployment.failed"] }),
      });
      if (!res.ok) throw new Error(`addDeploymentWebhook failed: HTTP ${res.status}`);
    },

    async deleteProject(projectId) {
      const teamId = getTeamId();
      const qs = teamId ? `?teamId=${teamId}` : "";
      const res = await vFetch(`/v9/projects/${projectId}${qs}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) throw new Error(`deleteProject failed: HTTP ${res.status}`);
    },
  };
}

// ── Store helpers ─────────────────────────────────────────────────────────────

const PROVIDER_KEY = "Vercel-Provisioned";
const DEFAULT_WEBHOOK = process.env.TRENT_WEBHOOK_BASE_URL
  ? `${process.env.TRENT_WEBHOOK_BASE_URL}/api/webhooks/vercel`
  : "https://trent.app/api/webhooks/vercel";

async function loadResource(companyId: string): Promise<VercelProvisionedResource | null> {
  const integration = await store.getIntegration(companyId, PROVIDER_KEY);
  if (!integration?.encryptedData) return null;
  try { return decryptJson<VercelProvisionedResource>(integration.encryptedData); } catch { return null; }
}

async function saveResource(companyId: string, resource: VercelProvisionedResource): Promise<void> {
  await store.upsertIntegration({
    companyId,
    provider: PROVIDER_KEY,
    scopes: ["deploy"],
    status: "connected",
    encryptedData: encryptJson(resource),
  });
}

async function removeResource(companyId: string): Promise<void> {
  const integration = await store.getIntegration(companyId, PROVIDER_KEY);
  if (integration) await store.revokeIntegration(integration.id);
}

function sanitizeError(err: unknown, context: string): Error {
  const raw = err instanceof Error ? err.message : String(err);
  const sanitized = raw
    // Vercel and similar service tokens (vercel_*, bearer tokens)
    .replace(/vercel_[A-Za-z0-9_\-]+/gi, "[REDACTED]")
    // Long opaque token blobs (20+ chars alphanumeric/underscore/hyphen)
    .replace(/[A-Za-z0-9_\-]{20,}/g, "[REDACTED]");
  return new Error(`[${context}] ${sanitized}`);
}

// ── provision() ───────────────────────────────────────────────────────────────

export async function provision(
  input: VercelProvisionInput,
  client: VercelApiClient
): Promise<VercelProvisionedResource> {
  const { companyId, companySlug, envVars, webhookUrl = DEFAULT_WEBHOOK } = input;

  const existing = await loadResource(companyId);
  if (existing) return existing;

  let projectId: string | undefined;
  let created: VercelProvisionedResource;

  try {
    created = await client.createProject({ name: companySlug });
    projectId = created.projectId;
  } catch (err: unknown) {
    throw sanitizeError(err, "hosting.create-project");
  }

  try {
    if (envVars && Object.keys(envVars).length > 0) {
      await client.injectEnvVars({ projectId: created.projectId, teamId: created.teamId, envVars });
    }

    await client.addDeploymentWebhook({
      projectId: created.projectId,
      teamId: created.teamId,
      webhookUrl,
    });

    await saveResource(companyId, created);

    await appendAuditLog(
      companyId,
      "system",
      "hosting.provision",
      "vercel_project",
      created.projectId,
      `Provisioned Vercel project ${created.projectName}`
    );

    return created;
  } catch (err: unknown) {
    if (projectId) {
      try { await client.deleteProject(projectId); } catch { /* best-effort */ }
    }
    throw sanitizeError(err, "hosting.provision");
  }
}

// ── rollback() ────────────────────────────────────────────────────────────────

export async function rollback(input: VercelRollbackInput, client: VercelApiClient): Promise<void> {
  const { companyId, projectId } = input;
  const integration = await store.getIntegration(companyId, PROVIDER_KEY);
  if (!integration) return;

  try { await client.deleteProject(projectId); } catch (err: unknown) {
    throw sanitizeError(err, "hosting.rollback");
  }

  await removeResource(companyId);
  await appendAuditLog(companyId, "system", "hosting.rollback", "vercel_project", projectId, `Rolled back Vercel project ${projectId}`);
}

// ── getStatus() ───────────────────────────────────────────────────────────────

export async function getStatus(companyId: string): Promise<VercelProvisionedResource | null> {
  return loadResource(companyId);
}
