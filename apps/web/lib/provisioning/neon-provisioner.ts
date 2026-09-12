/**
 * lib/provisioning/neon-provisioner.ts
 *
 * Provisions a Neon Postgres project per company with branch-per-environment:
 *   main     — production (never written to by workbench agents)
 *   staging  — staging environment
 *   preview  — ephemeral preview builds
 *
 * Rollback contract:
 *   If any step after createProject fails, deleteProject is called before re-throwing.
 *   Deleting a project removes all its branches — no partial branch cleanup needed.
 *
 * Idempotency:
 *   provision() reads store.getIntegration(companyId, "Neon-Provisioned") first.
 *   If a record exists, the decrypted resource is returned with zero API calls.
 *
 * Credential boundary:
 *   Neon connection strings (postgres://role:password@host/db) are stored only
 *   inside encryptedData — never in plain text, logs, or error messages.
 *
 * Async provisioning:
 *   Neon project creation is async in production. The real client must poll until
 *   ready before returning connection strings. In tests, the mock returns immediately.
 *   Long-running polling is delegated to the n8n neon-status-poll workflow.
 */

import { store } from "@/lib/store";
import { encryptJson, decryptJson } from "@/lib/secrets";
import { appendAuditLog } from "@/lib/audit-log";

// ── Public types ──────────────────────────────────────────────────────────────

export type NeonProvisionedResource = {
  /** Neon project ID */
  projectId: string;
  /** Branch ID for the main (production) branch */
  mainBranchId: string;
  /** Branch ID for the staging branch */
  stagingBranchId: string;
  /** Branch ID for the preview branch */
  previewBranchId: string;
  /** Connection strings per environment — stored encrypted, never logged */
  connectionStrings: {
    main: string;
    staging: string;
    preview: string;
  };
};

export type NeonProvisionInput = {
  companyId: string;
  /** Used as the Neon project name for easy identification */
  companySlug: string;
};

export type NeonRollbackInput = {
  companyId: string;
  projectId: string;
};

// ── API client interface ──────────────────────────────────────────────────────

export interface NeonApiClient {
  createProject(input: { name: string; regionId?: string }): Promise<{
    projectId: string;
    mainBranchId: string;
    mainConnectionString: string;
  }>;

  createBranch(input: { projectId: string; name: string; parentBranchId: string }): Promise<{
    branchId: string;
    connectionString: string;
  }>;

  deleteProject(projectId: string): Promise<void>;
}

// ── Real API client (production) ──────────────────────────────────────────────

export function createNeonApiClient(): NeonApiClient {
  function getApiKey(): string {
    const key = process.env.NEON_API_KEY;
    if (!key) throw new Error("NEON_API_KEY env var is required");
    return key;
  }

  async function neonFetch(path: string, options: RequestInit = {}): Promise<Response> {
    const key = getApiKey();
    return fetch(`https://console.neon.tech/api/v2${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(options.headers ?? {}),
      },
    });
  }

  async function waitForReady(projectId: string): Promise<void> {
    for (let attempt = 0; attempt < 30; attempt++) {
      const res = await neonFetch(`/projects/${projectId}`);
      if (!res.ok) throw new Error(`Neon project status check failed: HTTP ${res.status}`);
      const data = await res.json() as { project: { provisioner_state?: string } };
      if (!data.project.provisioner_state || data.project.provisioner_state === "active") return;
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error("Neon project did not reach ready state within 60 seconds");
  }

  return {
    async createProject({ name, regionId = "aws-us-east-1" }) {
      const res = await neonFetch("/projects", {
        method: "POST",
        body: JSON.stringify({ project: { name, region_id: regionId } }),
      });
      if (!res.ok) throw new Error(`createProject failed: HTTP ${res.status}`);
      const data = await res.json() as {
        project: { id: string };
        branch: { id: string };
        connection_uris: Array<{ connection_uri: string }>;
      };

      const projectId = data.project.id;
      await waitForReady(projectId);

      return {
        projectId,
        mainBranchId: data.branch.id,
        mainConnectionString: data.connection_uris[0]?.connection_uri ?? "",
      };
    },

    async createBranch({ projectId, name, parentBranchId }) {
      const res = await neonFetch(`/projects/${projectId}/branches`, {
        method: "POST",
        body: JSON.stringify({ branch: { name, parent_id: parentBranchId } }),
      });
      if (!res.ok) throw new Error(`createBranch failed: HTTP ${res.status}`);
      const data = await res.json() as {
        branch: { id: string };
        connection_uris: Array<{ connection_uri: string }>;
      };
      return {
        branchId: data.branch.id,
        connectionString: data.connection_uris[0]?.connection_uri ?? "",
      };
    },

    async deleteProject(projectId) {
      const res = await neonFetch(`/projects/${projectId}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) {
        throw new Error(`deleteProject failed: HTTP ${res.status}`);
      }
    },
  };
}

// ── Store helpers ─────────────────────────────────────────────────────────────

const PROVIDER_KEY = "Neon-Provisioned";

async function loadResource(companyId: string): Promise<NeonProvisionedResource | null> {
  const integration = await store.getIntegration(companyId, PROVIDER_KEY);
  if (!integration?.encryptedData) return null;
  try {
    return decryptJson<NeonProvisionedResource>(integration.encryptedData);
  } catch {
    return null;
  }
}

async function saveResource(companyId: string, resource: NeonProvisionedResource): Promise<void> {
  await store.upsertIntegration({
    companyId,
    provider: PROVIDER_KEY,
    scopes: ["readwrite"],
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

// ── Credential scrubbing ──────────────────────────────────────────────────────

function sanitizeError(err: unknown, context: string): Error {
  const raw = err instanceof Error ? err.message : String(err);

  // Strip Postgres connection strings: postgres://user:pass@host/db
  const CONN_STRING = /postgres(?:ql)?:\/\/[^\s"']+/gi;
  // Strip long base64 / opaque token blobs (40+ chars)
  const TOKEN_BLOB = /[A-Za-z0-9_\-]{40,}/g;

  const sanitized = raw
    .replace(CONN_STRING, "[CONNECTION_STRING_REDACTED]")
    .replace(TOKEN_BLOB, "[REDACTED]");

  return new Error(`[${context}] ${sanitized}`);
}

// ── provision() ───────────────────────────────────────────────────────────────

export async function provision(
  input: NeonProvisionInput,
  client: NeonApiClient
): Promise<NeonProvisionedResource> {
  const { companyId, companySlug } = input;

  // Idempotency
  const existing = await loadResource(companyId);
  if (existing) return existing;

  // Step 1: Create project (main branch included)
  let projectId: string | undefined;
  let created: Awaited<ReturnType<NeonApiClient["createProject"]>>;
  try {
    created = await client.createProject({ name: companySlug });
    projectId = created.projectId;
  } catch (err: unknown) {
    throw sanitizeError(err, "db.create-project");
  }

  // Steps 2–3: Create staging + preview branches, with project rollback on failure
  try {
    const staging = await client.createBranch({
      projectId: created.projectId,
      name: "staging",
      parentBranchId: created.mainBranchId,
    });

    const preview = await client.createBranch({
      projectId: created.projectId,
      name: "preview",
      parentBranchId: created.mainBranchId,
    });

    const resource: NeonProvisionedResource = {
      projectId: created.projectId,
      mainBranchId: created.mainBranchId,
      stagingBranchId: staging.branchId,
      previewBranchId: preview.branchId,
      connectionStrings: {
        main: created.mainConnectionString,
        staging: staging.connectionString,
        preview: preview.connectionString,
      },
    };

    await saveResource(companyId, resource);

    await appendAuditLog(
      companyId,
      "system",
      "db.provision",
      "neon_project",
      created.projectId,
      `Provisioned Neon project ${created.projectId} with staging and preview branches`
    );

    return resource;
  } catch (err: unknown) {
    // Rollback: delete project (removes all branches with it)
    if (projectId) {
      try {
        await client.deleteProject(projectId);
      } catch {
        // Best-effort cleanup
      }
    }
    throw sanitizeError(err, "db.provision");
  }
}

// ── rollback() ────────────────────────────────────────────────────────────────

export async function rollback(
  input: NeonRollbackInput,
  client: NeonApiClient
): Promise<void> {
  const { companyId, projectId } = input;

  const integration = await store.getIntegration(companyId, PROVIDER_KEY);
  if (!integration) return;

  try {
    await client.deleteProject(projectId);
  } catch (err: unknown) {
    throw sanitizeError(err, "db.rollback");
  }

  await removeResource(companyId);

  await appendAuditLog(
    companyId,
    "system",
    "db.rollback",
    "neon_project",
    projectId,
    `Rolled back Neon project ${projectId}`
  );
}

// ── getStatus() ───────────────────────────────────────────────────────────────

export async function getStatus(companyId: string): Promise<NeonProvisionedResource | null> {
  return loadResource(companyId);
}
