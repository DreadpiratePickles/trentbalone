/**
 * lib/provisioning/dns-provisioner.ts
 *
 * Cloudflare DNS automation: subdomain CNAME → hosting origin + Universal SSL cert.
 * Subdomain format: {slug}.trent.app
 *
 * DNS propagation is async — provisioner returns immediately with certStatus="pending".
 * n8n polls Cloudflare until cert reaches "active" state, then surfaces the live URL.
 */

import { store } from "@/lib/store";
import { encryptJson, decryptJson } from "@/lib/secrets";
import { appendAuditLog } from "@/lib/audit-log";

export type DnsProvisionedResource = {
  subdomain: string;
  fqdn: string;
  dnsRecordId: string;
  certStatus: "pending" | "active" | "error";
};

export type DnsProvisionInput = {
  companyId: string;
  companySlug: string;
  /** Hosting origin to point the CNAME at, e.g. "acme-co.vercel.app" */
  targetOrigin: string;
};

export type DnsRollbackInput = { companyId: string; dnsRecordId: string };

export interface DnsApiClient {
  createSubdomainRecord(input: { zoneId: string; subdomain: string; target: string }): Promise<{ dnsRecordId: string }>;
  enableUniversalCert(input: { zoneId: string }): Promise<{ certStatus: string }>;
  deleteRecord(dnsRecordId: string): Promise<void>;
}

export function createDnsApiClient(): DnsApiClient {
  function getToken() { return process.env.CLOUDFLARE_API_TOKEN ?? ""; }
  function getZoneId() { const id = process.env.CLOUDFLARE_ZONE_ID; if (!id) throw new Error("CLOUDFLARE_ZONE_ID required"); return id; }

  async function cfFetch(path: string, options: RequestInit = {}): Promise<Response> {
    return fetch(`https://api.cloudflare.com/client/v4${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${getToken()}`, "Content-Type": "application/json", ...(options.headers ?? {}) },
    });
  }

  return {
    async createSubdomainRecord({ zoneId, subdomain, target }) {
      const res = await cfFetch(`/zones/${zoneId}/dns_records`, {
        method: "POST",
        body: JSON.stringify({ type: "CNAME", name: subdomain, content: target, proxied: true }),
      });
      if (!res.ok) throw new Error(`createSubdomainRecord failed: HTTP ${res.status}`);
      const data = await res.json() as { result: { id: string } };
      return { dnsRecordId: data.result.id };
    },
    async enableUniversalCert({ zoneId }) {
      const res = await cfFetch(`/zones/${zoneId}/ssl/universal/settings`, {
        method: "PATCH", body: JSON.stringify({ enabled: true }),
      });
      if (!res.ok) throw new Error(`enableUniversalCert failed: HTTP ${res.status}`);
      return { certStatus: "pending" };
    },
    async deleteRecord(dnsRecordId) {
      const zoneId = getZoneId();
      const res = await cfFetch(`/zones/${zoneId}/dns_records/${dnsRecordId}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) throw new Error(`deleteRecord failed: HTTP ${res.status}`);
    },
  };
}

const PROVIDER_KEY = "DNS-Provisioned";
const PLATFORM_DOMAIN = process.env.TRENT_PLATFORM_DOMAIN ?? "trent.app";

async function load(companyId: string): Promise<DnsProvisionedResource | null> {
  const i = await store.getIntegration(companyId, PROVIDER_KEY);
  if (!i?.encryptedData) return null;
  try { return decryptJson<DnsProvisionedResource>(i.encryptedData); } catch { return null; }
}
async function save(companyId: string, r: DnsProvisionedResource) {
  await store.upsertIntegration({ companyId, provider: PROVIDER_KEY, scopes: ["dns"], status: "connected", encryptedData: encryptJson(r) });
}
async function rem(companyId: string) {
  const i = await store.getIntegration(companyId, PROVIDER_KEY);
  if (i) await store.revokeIntegration(i.id);
}
function san(err: unknown, ctx: string) {
  const raw = err instanceof Error ? err.message : String(err);
  return new Error(`[${ctx}] ${raw.replace(/[A-Za-z0-9_\-]{30,}/g, "[REDACTED]")}`);
}

export async function provision(input: DnsProvisionInput, client: DnsApiClient): Promise<DnsProvisionedResource> {
  const { companyId, companySlug, targetOrigin } = input;

  const existing = await load(companyId);
  if (existing) return existing;

  const zoneId = process.env.CLOUDFLARE_ZONE_ID ?? "mock-zone";
  let dnsRecordId: string | undefined;

  try {
    const { dnsRecordId: recId } = await client.createSubdomainRecord({
      zoneId, subdomain: `${companySlug}.${PLATFORM_DOMAIN}`, target: targetOrigin,
    });
    dnsRecordId = recId;
  } catch (err: unknown) {
    throw san(err, "dns.create-record");
  }

  try {
    const { certStatus } = await client.enableUniversalCert({ zoneId });

    const resource: DnsProvisionedResource = {
      subdomain: companySlug,
      fqdn: `${companySlug}.${PLATFORM_DOMAIN}`,
      dnsRecordId: dnsRecordId!,
      certStatus: certStatus as DnsProvisionedResource["certStatus"],
    };
    await save(companyId, resource);
    await appendAuditLog(companyId, "system", "dns.provision", "dns_record", dnsRecordId!, `Provisioned subdomain ${resource.fqdn}`);
    return resource;
  } catch (err: unknown) {
    if (dnsRecordId) { try { await client.deleteRecord(dnsRecordId); } catch { /* best-effort */ } }
    throw san(err, "dns.provision");
  }
}

export async function rollback(input: DnsRollbackInput, client: DnsApiClient): Promise<void> {
  const { companyId, dnsRecordId } = input;
  const i = await store.getIntegration(companyId, PROVIDER_KEY);
  if (!i) return;
  try { await client.deleteRecord(dnsRecordId); } catch (err: unknown) { throw san(err, "dns.rollback"); }
  await rem(companyId);
  await appendAuditLog(companyId, "system", "dns.rollback", "dns_record", dnsRecordId, `Rolled back DNS record ${dnsRecordId}`);
}

export async function getStatus(companyId: string): Promise<DnsProvisionedResource | null> {
  return load(companyId);
}
