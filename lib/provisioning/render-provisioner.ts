/**
 * lib/provisioning/render-provisioner.ts
 *
 * Fallback hosting provisioner (Render). Used when Vercel is unavailable
 * or the founder explicitly selects Render as their hosting provider.
 *
 * Same rollback/idempotency contract as vercel-provisioner.ts.
 * Provider key: "Render-Provisioned"
 */

import { store } from "@/lib/store";
import { encryptJson, decryptJson } from "@/lib/secrets";
import { appendAuditLog } from "@/lib/audit-log";

// ── Public types ──────────────────────────────────────────────────────────────

export type RenderProvisionedResource = {
  serviceId: string;
  serviceName: string;
  serviceUrl: string;
};

export type RenderProvisionInput = {
  companyId: string;
  companySlug: string;
  envVars?: Record<string, string>;
  webhookUrl?: string;
};

export type RenderRollbackInput = {
  companyId: string;
  serviceId: string;
};

// ── API client interface ──────────────────────────────────────────────────────

export interface RenderApiClient {
  createService(input: { name: string; ownerId?: string }): Promise<RenderProvisionedResource>;
  updateEnvVars(input: { serviceId: string; envVars: Record<string, string> }): Promise<void>;
  addWebhook(input: { serviceId: string; webhookUrl: string }): Promise<void>;
  deleteService(serviceId: string): Promise<void>;
}

// ── Real API client ───────────────────────────────────────────────────────────

export function createRenderApiClient(): RenderApiClient {
  function getKey(): string {
    const k = process.env.RENDER_API_KEY;
    if (!k) throw new Error("RENDER_API_KEY env var is required");
    return k;
  }

  async function rFetch(path: string, options: RequestInit = {}): Promise<Response> {
    return fetch(`https://api.render.com/v1${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${getKey()}`,
        "Content-Type": "application/json",
        ...(options.headers ?? {}),
      },
    });
  }

  return {
    async createService({ name, ownerId }) {
      const res = await rFetch("/services", {
        method: "POST",
        body: JSON.stringify({
          type: "web_service",
          name,
          ownerId: ownerId ?? process.env.RENDER_OWNER_ID,
          autoDeploy: "yes",
        }),
      });
      if (!res.ok) throw new Error(`createService failed: HTTP ${res.status}`);
      const data = await res.json() as { service: { id: string; name: string; serviceDetails?: { url?: string } } };
      return {
        serviceId: data.service.id,
        serviceName: data.service.name,
        serviceUrl: data.service.serviceDetails?.url ?? `https://${name}.onrender.com`,
      };
    },

    async updateEnvVars({ serviceId, envVars }) {
      const body = Object.entries(envVars).map(([key, value]) => ({ key, value }));
      const res = await rFetch(`/services/${serviceId}/env-vars`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`updateEnvVars failed: HTTP ${res.status}`);
    },

    async addWebhook({ serviceId, webhookUrl }) {
      const res = await rFetch(`/services/${serviceId}/notifications`, {
        method: "POST",
        body: JSON.stringify({ type: "webhook", url: webhookUrl }),
      });
      if (!res.ok) throw new Error(`addWebhook failed: HTTP ${res.status}`);
    },

    async deleteService(serviceId) {
      const res = await rFetch(`/services/${serviceId}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) throw new Error(`deleteService failed: HTTP ${res.status}`);
    },
  };
}

// ── Store helpers ─────────────────────────────────────────────────────────────

const PROVIDER_KEY = "Render-Provisioned";
const DEFAULT_WEBHOOK = process.env.TRENT_WEBHOOK_BASE_URL
  ? `${process.env.TRENT_WEBHOOK_BASE_URL}/api/webhooks/render`
  : "https://trent.app/api/webhooks/render";

async function loadResource(companyId: string): Promise<RenderProvisionedResource | null> {
  const integration = await store.getIntegration(companyId, PROVIDER_KEY);
  if (!integration?.encryptedData) return null;
  try { return decryptJson<RenderProvisionedResource>(integration.encryptedData); } catch { return null; }
}

async function saveResource(companyId: string, resource: RenderProvisionedResource): Promise<void> {
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
  const sanitized = raw.replace(/[A-Za-z0-9_\-]{20,}/g, "[REDACTED]");
  return new Error(`[${context}] ${sanitized}`);
}

// ── provision() ───────────────────────────────────────────────────────────────

export async function provision(
  input: RenderProvisionInput,
  client: RenderApiClient
): Promise<RenderProvisionedResource> {
  const { companyId, companySlug, envVars, webhookUrl = DEFAULT_WEBHOOK } = input;

  const existing = await loadResource(companyId);
  if (existing) return existing;

  let serviceId: string | undefined;
  let created: RenderProvisionedResource;

  try {
    created = await client.createService({ name: companySlug });
    serviceId = created.serviceId;
  } catch (err: unknown) {
    throw sanitizeError(err, "hosting.create-service");
  }

  try {
    if (envVars && Object.keys(envVars).length > 0) {
      await client.updateEnvVars({ serviceId: created.serviceId, envVars });
    }

    await client.addWebhook({ serviceId: created.serviceId, webhookUrl });

    await saveResource(companyId, created);

    await appendAuditLog(
      companyId,
      "system",
      "hosting.provision",
      "render_service",
      created.serviceId,
      `Provisioned Render service ${created.serviceName}`
    );

    return created;
  } catch (err: unknown) {
    if (serviceId) {
      try { await client.deleteService(serviceId); } catch { /* best-effort */ }
    }
    throw sanitizeError(err, "hosting.provision");
  }
}

// ── rollback() ────────────────────────────────────────────────────────────────

export async function rollback(input: RenderRollbackInput, client: RenderApiClient): Promise<void> {
  const { companyId, serviceId } = input;
  const integration = await store.getIntegration(companyId, PROVIDER_KEY);
  if (!integration) return;

  try { await client.deleteService(serviceId); } catch (err: unknown) {
    throw sanitizeError(err, "hosting.rollback");
  }

  await removeResource(companyId);
  await appendAuditLog(companyId, "system", "hosting.rollback", "render_service", serviceId, `Rolled back Render service ${serviceId}`);
}

// ── getStatus() ───────────────────────────────────────────────────────────────

export async function getStatus(companyId: string): Promise<RenderProvisionedResource | null> {
  return loadResource(companyId);
}
