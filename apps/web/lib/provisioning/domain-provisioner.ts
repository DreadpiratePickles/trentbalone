/**
 * lib/provisioning/domain-provisioner.ts
 *
 * Custom domain SSL provisioning. The founder provides a domain they own;
 * Trent adds it to Cloudflare, verifies ownership, and provisions an SSL cert.
 *
 * Flow:
 *   1. addCustomDomain — registers domain with Cloudflare, returns TXT verification record
 *   2. provisionCert   — triggers Universal SSL or ACME cert order (returns certStatus=pending)
 *
 * After provision(), the caller must show the founder the TXT verification record.
 * n8n polls cert status until "active", then notifies the founder.
 */

import { store } from "@/lib/store";
import { encryptJson, decryptJson } from "@/lib/secrets";
import { appendAuditLog } from "@/lib/audit-log";

export type DomainProvisionedResource = {
  customDomain: string;
  verificationRecordName: string;
  verificationRecordValue: string;
  certStatus: "pending" | "active" | "error";
  sslZoneId: string;
};

export type DomainProvisionInput = {
  companyId: string;
  customDomain: string;
  targetOrigin: string;
};

export type DomainRollbackInput = {
  companyId: string;
  customDomain: string;
  sslZoneId: string;
};

export interface DomainApiClient {
  addCustomDomain(input: { customDomain: string; targetOrigin: string }): Promise<{
    verificationRecordName: string;
    verificationRecordValue: string;
    sslZoneId: string;
    certStatus: string;
  }>;
  provisionCert(input: { sslZoneId: string }): Promise<{ certStatus: string }>;
  removeCustomDomain(input: { customDomain: string; sslZoneId: string }): Promise<void>;
}

export function createDomainApiClient(): DomainApiClient {
  function getToken() { return process.env.CLOUDFLARE_API_TOKEN ?? ""; }
  async function cfFetch(path: string, options: RequestInit = {}): Promise<Response> {
    return fetch(`https://api.cloudflare.com/client/v4${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${getToken()}`, "Content-Type": "application/json", ...(options.headers ?? {}) },
    });
  }
  return {
    async addCustomDomain({ customDomain, targetOrigin }) {
      const res = await cfFetch("/zones", {
        method: "POST", body: JSON.stringify({ name: customDomain, type: "partial" }),
      });
      if (!res.ok) throw new Error(`addCustomDomain failed: HTTP ${res.status}`);
      const data = await res.json() as { result: { id: string; verification_key?: string; name_servers?: string[] } };
      return {
        verificationRecordName: `_cf-verify.${customDomain}`,
        verificationRecordValue: data.result.verification_key ?? "verify-token",
        sslZoneId: data.result.id,
        certStatus: "pending",
      };
    },
    async provisionCert({ sslZoneId }) {
      const res = await cfFetch(`/zones/${sslZoneId}/ssl/universal/settings`, {
        method: "PATCH", body: JSON.stringify({ enabled: true }),
      });
      if (!res.ok) throw new Error(`provisionCert failed: HTTP ${res.status}`);
      return { certStatus: "pending" };
    },
    async removeCustomDomain({ sslZoneId }) {
      const res = await cfFetch(`/zones/${sslZoneId}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) throw new Error(`removeCustomDomain failed: HTTP ${res.status}`);
    },
  };
}

const PROVIDER_KEY = "Domain-Provisioned";

async function load(companyId: string): Promise<DomainProvisionedResource | null> {
  const i = await store.getIntegration(companyId, PROVIDER_KEY);
  if (!i?.encryptedData) return null;
  try { return decryptJson<DomainProvisionedResource>(i.encryptedData); } catch { return null; }
}
async function save(companyId: string, r: DomainProvisionedResource) {
  await store.upsertIntegration({ companyId, provider: PROVIDER_KEY, scopes: ["ssl"], status: "connected", encryptedData: encryptJson(r) });
}
async function rem(companyId: string) {
  const i = await store.getIntegration(companyId, PROVIDER_KEY);
  if (i) await store.revokeIntegration(i.id);
}
function san(err: unknown, ctx: string) {
  const raw = err instanceof Error ? err.message : String(err);
  return new Error(`[${ctx}] ${raw.replace(/[A-Za-z0-9_\-]{30,}/g, "[REDACTED]")}`);
}

export async function provision(input: DomainProvisionInput, client: DomainApiClient): Promise<DomainProvisionedResource> {
  const { companyId, customDomain, targetOrigin } = input;

  const existing = await load(companyId);
  if (existing) return existing;

  let sslZoneId: string | undefined;

  try {
    const { verificationRecordName, verificationRecordValue, sslZoneId: zoneId, certStatus } =
      await client.addCustomDomain({ customDomain, targetOrigin });
    sslZoneId = zoneId;

    await client.provisionCert({ sslZoneId: zoneId });

    const resource: DomainProvisionedResource = {
      customDomain,
      verificationRecordName,
      verificationRecordValue,
      certStatus: certStatus as DomainProvisionedResource["certStatus"],
      sslZoneId: zoneId,
    };
    await save(companyId, resource);
    await appendAuditLog(companyId, "system", "domain.provision", "custom_domain", customDomain, `Provisioned custom domain ${customDomain}`);
    return resource;
  } catch (err: unknown) {
    if (sslZoneId) {
      try { await client.removeCustomDomain({ customDomain, sslZoneId }); } catch { /* best-effort */ }
    }
    throw san(err, "domain.provision");
  }
}

export async function rollback(input: DomainRollbackInput, client: DomainApiClient): Promise<void> {
  const { companyId, customDomain, sslZoneId } = input;
  const i = await store.getIntegration(companyId, PROVIDER_KEY);
  if (!i) return;
  try { await client.removeCustomDomain({ customDomain, sslZoneId }); } catch (err: unknown) { throw san(err, "domain.rollback"); }
  await rem(companyId);
  await appendAuditLog(companyId, "system", "domain.rollback", "custom_domain", customDomain, `Rolled back custom domain ${customDomain}`);
}

export async function getStatus(companyId: string): Promise<DomainProvisionedResource | null> {
  return load(companyId);
}
