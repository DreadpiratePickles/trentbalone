/**
 * lib/provisioning/r2-provisioner.ts
 *
 * Cloudflare R2 per-company storage bucket: create, CORS policy, CDN / public access.
 * Signed URL generation is handled by the API surface layer, not here.
 */

import { store } from "@/lib/store";
import { encryptJson, decryptJson } from "@/lib/secrets";
import { appendAuditLog } from "@/lib/audit-log";

export type R2ProvisionedResource = {
  bucketName: string;
  publicUrl: string;
  cdnUrl?: string;
};

export type R2ProvisionInput = { companyId: string; companySlug: string };
export type R2RollbackInput = { companyId: string; bucketName: string };

export interface R2ApiClient {
  createBucket(input: { name: string; accountId: string }): Promise<{ bucketName: string }>;
  setCorsPolicy(input: { bucketName: string; accountId: string }): Promise<void>;
  enablePublicAccess(input: { bucketName: string; accountId: string }): Promise<{ publicUrl: string; cdnUrl: string }>;
  deleteBucket(bucketName: string): Promise<void>;
}

export function createR2ApiClient(): R2ApiClient {
  function getToken() { return process.env.CLOUDFLARE_API_TOKEN ?? ""; }
  function getAccountId() { const id = process.env.CLOUDFLARE_ACCOUNT_ID; if (!id) throw new Error("CLOUDFLARE_ACCOUNT_ID required"); return id; }

  async function cfFetch(path: string, options: RequestInit = {}): Promise<Response> {
    return fetch(`https://api.cloudflare.com/client/v4${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${getToken()}`, "Content-Type": "application/json", ...(options.headers ?? {}) },
    });
  }

  return {
    async createBucket({ name, accountId }) {
      const res = await cfFetch(`/accounts/${accountId}/r2/buckets`, {
        method: "POST", body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error(`createBucket failed: HTTP ${res.status}`);
      return { bucketName: name };
    },
    async setCorsPolicy({ bucketName, accountId }) {
      const res = await cfFetch(`/accounts/${accountId}/r2/buckets/${bucketName}/cors`, {
        method: "PUT",
        body: JSON.stringify({ rules: [{ allowedMethods: ["GET", "PUT"], allowedOrigins: ["*"], allowedHeaders: ["*"] }] }),
      });
      if (!res.ok) throw new Error(`setCorsPolicy failed: HTTP ${res.status}`);
    },
    async enablePublicAccess({ bucketName, accountId }) {
      const res = await cfFetch(`/accounts/${accountId}/r2/buckets/${bucketName}/domains/managed`, {
        method: "PUT", body: JSON.stringify({ enabled: true }),
      });
      if (!res.ok) throw new Error(`enablePublicAccess failed: HTTP ${res.status}`);
      return {
        publicUrl: `https://${bucketName}.r2.dev`,
        cdnUrl: `https://${bucketName}.r2.dev`,
      };
    },
    async deleteBucket(bucketName) {
      const accountId = getAccountId();
      const res = await cfFetch(`/accounts/${accountId}/r2/buckets/${bucketName}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) throw new Error(`deleteBucket failed: HTTP ${res.status}`);
    },
  };
}

const PROVIDER_KEY = "R2-Provisioned";

async function load(companyId: string): Promise<R2ProvisionedResource | null> {
  const i = await store.getIntegration(companyId, PROVIDER_KEY);
  if (!i?.encryptedData) return null;
  try { return decryptJson<R2ProvisionedResource>(i.encryptedData); } catch { return null; }
}
async function save(companyId: string, r: R2ProvisionedResource) {
  await store.upsertIntegration({ companyId, provider: PROVIDER_KEY, scopes: ["storage"], status: "connected", encryptedData: encryptJson(r) });
}
async function remove(companyId: string) {
  const i = await store.getIntegration(companyId, PROVIDER_KEY);
  if (i) await store.revokeIntegration(i.id);
}
function san(err: unknown, ctx: string) {
  const raw = err instanceof Error ? err.message : String(err);
  return new Error(`[${ctx}] ${raw.replace(/[A-Za-z0-9_\-]{30,}/g, "[REDACTED]")}`);
}

export async function provision(input: R2ProvisionInput, client: R2ApiClient): Promise<R2ProvisionedResource> {
  const { companyId, companySlug } = input;
  const existing = await load(companyId);
  if (existing) return existing;

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "mock-account";
  const bucketName = `trent-${companySlug}`;
  let created = false;

  try {
    await client.createBucket({ name: bucketName, accountId });
    created = true;
  } catch (err: unknown) {
    throw san(err, "storage.create-bucket");
  }

  try {
    await client.setCorsPolicy({ bucketName, accountId });
    const { publicUrl, cdnUrl } = await client.enablePublicAccess({ bucketName, accountId });

    const resource: R2ProvisionedResource = { bucketName, publicUrl, cdnUrl };
    await save(companyId, resource);
    await appendAuditLog(companyId, "system", "storage.provision", "r2_bucket", bucketName, `Provisioned R2 bucket ${bucketName}`);
    return resource;
  } catch (err: unknown) {
    if (created) { try { await client.deleteBucket(bucketName); } catch { /* best-effort */ } }
    throw san(err, "storage.provision");
  }
}

export async function rollback(input: R2RollbackInput, client: R2ApiClient): Promise<void> {
  const { companyId, bucketName } = input;
  const i = await store.getIntegration(companyId, PROVIDER_KEY);
  if (!i) return;
  try { await client.deleteBucket(bucketName); } catch (err: unknown) { throw san(err, "storage.rollback"); }
  await remove(companyId);
  await appendAuditLog(companyId, "system", "storage.rollback", "r2_bucket", bucketName, `Rolled back R2 bucket ${bucketName}`);
}

export async function getStatus(companyId: string): Promise<R2ProvisionedResource | null> {
  return load(companyId);
}
