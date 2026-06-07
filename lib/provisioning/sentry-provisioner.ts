/**
 * lib/provisioning/sentry-provisioner.ts
 *
 * Sentry project per generated app: create project, retrieve DSN, configure client key.
 * DSN is treated as a secret — stored only in encryptedData, never in audit logs or plain text.
 */

import { store } from "@/lib/store";
import { encryptJson, decryptJson } from "@/lib/secrets";
import { appendAuditLog } from "@/lib/audit-log";

export type SentryProvisionedResource = {
  projectId: string;
  projectSlug: string;
  dsn: string;
  orgSlug: string;
};

export type SentryProvisionInput = { companyId: string; companySlug: string };
export type SentryRollbackInput = { companyId: string; projectId: string };

export interface SentryApiClient {
  createProject(input: { org: string; team: string; name: string; platform?: string }): Promise<{
    projectId: string;
    projectSlug: string;
  }>;
  getDsn(input: { org: string; projectSlug: string }): Promise<{ dsn: string }>;
  deleteProject(projectId: string): Promise<void>;
}

export function createSentryApiClient(): SentryApiClient {
  function getToken() { return process.env.SENTRY_AUTH_TOKEN ?? ""; }
  function getOrg() { return process.env.SENTRY_ORG ?? "trent-platform"; }

  async function sFetch(path: string, options: RequestInit = {}): Promise<Response> {
    return fetch(`https://sentry.io/api/0${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${getToken()}`, "Content-Type": "application/json", ...(options.headers ?? {}) },
    });
  }

  return {
    async createProject({ org, team, name, platform = "javascript-nextjs" }) {
      const res = await sFetch(`/teams/${org}/${team}/projects/`, {
        method: "POST", body: JSON.stringify({ name, platform }),
      });
      if (!res.ok) throw new Error(`createProject failed: HTTP ${res.status}`);
      const data = await res.json() as { id: string; slug: string };
      return { projectId: data.id, projectSlug: data.slug };
    },
    async getDsn({ org, projectSlug }) {
      const res = await sFetch(`/projects/${org}/${projectSlug}/keys/`);
      if (!res.ok) throw new Error(`getDsn failed: HTTP ${res.status}`);
      const data = await res.json() as Array<{ dsn?: { public?: string } }>;
      const dsn = data[0]?.dsn?.public;
      if (!dsn) throw new Error("getDsn: no DSN found");
      return { dsn };
    },
    async deleteProject(projectId) {
      const org = getOrg();
      const res = await sFetch(`/projects/${org}/${projectId}/`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) throw new Error(`deleteProject failed: HTTP ${res.status}`);
    },
  };
}

const PROVIDER_KEY = "Sentry-Provisioned";

async function load(companyId: string): Promise<SentryProvisionedResource | null> {
  const i = await store.getIntegration(companyId, PROVIDER_KEY);
  if (!i?.encryptedData) return null;
  try { return decryptJson<SentryProvisionedResource>(i.encryptedData); } catch { return null; }
}
async function save(companyId: string, r: SentryProvisionedResource) {
  await store.upsertIntegration({ companyId, provider: PROVIDER_KEY, scopes: ["error-tracking"], status: "connected", encryptedData: encryptJson(r) });
}
async function rem(companyId: string) {
  const i = await store.getIntegration(companyId, PROVIDER_KEY);
  if (i) await store.revokeIntegration(i.id);
}
function san(err: unknown, ctx: string) {
  const raw = err instanceof Error ? err.message : String(err);
  return new Error(`[${ctx}] ${raw.replace(/[A-Za-z0-9_\-]{20,}/g, "[REDACTED]")}`);
}

export async function provision(input: SentryProvisionInput, client: SentryApiClient): Promise<SentryProvisionedResource> {
  const { companyId, companySlug } = input;
  const existing = await load(companyId);
  if (existing) return existing;

  const org = process.env.SENTRY_ORG ?? "trent-platform";
  const team = process.env.SENTRY_TEAM ?? "engineering";
  let projectId: string | undefined;

  try {
    const { projectId: pid, projectSlug } = await client.createProject({ org, team, name: companySlug });
    projectId = pid;

    const { dsn } = await client.getDsn({ org, projectSlug });

    const resource: SentryProvisionedResource = { projectId: pid, projectSlug, dsn, orgSlug: org };
    await save(companyId, resource);
    // Audit summary must NOT contain the DSN
    await appendAuditLog(companyId, "system", "observability.provision", "sentry_project", pid, `Provisioned Sentry project ${projectSlug}`);
    return resource;
  } catch (err: unknown) {
    if (projectId) { try { await client.deleteProject(projectId); } catch { /* best-effort */ } }
    throw san(err, "observability.provision");
  }
}

export async function rollback(input: SentryRollbackInput, client: SentryApiClient): Promise<void> {
  const { companyId, projectId } = input;
  const i = await store.getIntegration(companyId, PROVIDER_KEY);
  if (!i) return;
  try { await client.deleteProject(projectId); } catch (err: unknown) { throw san(err, "observability.rollback"); }
  await rem(companyId);
  await appendAuditLog(companyId, "system", "observability.rollback", "sentry_project", projectId, `Rolled back Sentry project ${projectId}`);
}

export async function getStatus(companyId: string): Promise<SentryProvisionedResource | null> {
  return load(companyId);
}
