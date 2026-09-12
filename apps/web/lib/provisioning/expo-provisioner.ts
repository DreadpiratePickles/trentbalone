/**
 * lib/provisioning/expo-provisioner.ts
 *
 * EAS Build pipeline per company: project creation, OTA update channels, push credentials.
 * EAS builds are long-running — provisioner creates the project; n8n polls build status.
 */

import { store } from "@/lib/store";
import { encryptJson, decryptJson } from "@/lib/secrets";
import { appendAuditLog } from "@/lib/audit-log";

export type ExpoProvisionedResource = {
  projectId: string;
  projectSlug: string;
  easProjectUrl: string;
  otaChannels: string[];
  pushCredentialsConfigured: boolean;
};

export type ExpoProvisionInput = { companyId: string; companySlug: string };
export type ExpoRollbackInput = { companyId: string; projectId: string };

export interface ExpoApiClient {
  createProject(input: { slug: string; org: string }): Promise<{ projectId: string; easProjectUrl: string }>;
  configureOtaChannels(input: { projectId: string; channels: string[] }): Promise<{ channels: string[] }>;
  deleteProject(projectId: string): Promise<void>;
}

export function createExpoApiClient(): ExpoApiClient {
  function getToken() { return process.env.EXPO_TOKEN ?? ""; }
  function getOrg() { return process.env.EXPO_ORG ?? "trent-platform"; }

  async function expFetch(path: string, options: RequestInit = {}): Promise<Response> {
    return fetch(`https://api.expo.dev/graphql`, {
      ...options,
      headers: { Authorization: `Bearer ${getToken()}`, "Content-Type": "application/json", ...(options.headers ?? {}) },
    });
  }

  return {
    async createProject({ slug, org }) {
      // EAS uses GraphQL mutations
      const body = JSON.stringify({
        query: `mutation CreateApp($input: CreateAppInput!) { createApp(appInput: $input) { id fullName } }`,
        variables: { input: { accountName: org, projectName: slug } },
      });
      const res = await expFetch("/", { method: "POST", body });
      if (!res.ok) throw new Error(`createProject failed: HTTP ${res.status}`);
      const data = await res.json() as { data?: { createApp?: { id: string; fullName: string } } };
      const app = data.data?.createApp;
      if (!app) throw new Error("createProject: unexpected response");
      return { projectId: app.id, easProjectUrl: `https://expo.dev/${app.fullName}` };
    },
    async configureOtaChannels({ projectId, channels }) {
      // simplified: real API creates channel entries
      return { channels };
    },
    async deleteProject(projectId) {
      const body = JSON.stringify({
        query: `mutation DeleteApp($appId: String!) { deleteApp(appId: $appId) { id } }`,
        variables: { appId: projectId },
      });
      const res = await expFetch("/", { method: "POST", body });
      if (!res.ok && res.status !== 404) throw new Error(`deleteProject failed: HTTP ${res.status}`);
    },
  };
}

const PROVIDER_KEY = "Expo-Provisioned";
const DEFAULT_CHANNELS = ["production", "staging", "preview"];

async function load(companyId: string): Promise<ExpoProvisionedResource | null> {
  const i = await store.getIntegration(companyId, PROVIDER_KEY);
  if (!i?.encryptedData) return null;
  try { return decryptJson<ExpoProvisionedResource>(i.encryptedData); } catch { return null; }
}
async function save(companyId: string, r: ExpoProvisionedResource) {
  await store.upsertIntegration({ companyId, provider: PROVIDER_KEY, scopes: ["build"], status: "connected", encryptedData: encryptJson(r) });
}
async function rem(companyId: string) {
  const i = await store.getIntegration(companyId, PROVIDER_KEY);
  if (i) await store.revokeIntegration(i.id);
}
function san(err: unknown, ctx: string) {
  const raw = err instanceof Error ? err.message : String(err);
  return new Error(`[${ctx}] ${raw.replace(/[A-Za-z0-9_\-]{30,}/g, "[REDACTED]")}`);
}

export async function provision(input: ExpoProvisionInput, client: ExpoApiClient): Promise<ExpoProvisionedResource> {
  const { companyId, companySlug } = input;
  const existing = await load(companyId);
  if (existing) return existing;

  const org = process.env.EXPO_ORG ?? "trent-platform";
  let projectId: string | undefined;

  try {
    const { projectId: pid, easProjectUrl } = await client.createProject({ slug: companySlug, org });
    projectId = pid;

    const { channels } = await client.configureOtaChannels({ projectId: pid, channels: DEFAULT_CHANNELS });

    const resource: ExpoProvisionedResource = {
      projectId: pid,
      projectSlug: companySlug,
      easProjectUrl,
      otaChannels: channels,
      pushCredentialsConfigured: false,
    };
    await save(companyId, resource);
    await appendAuditLog(companyId, "system", "mobile.provision", "expo_project", pid, `Provisioned EAS project for ${companySlug}`);
    return resource;
  } catch (err: unknown) {
    if (projectId) { try { await client.deleteProject(projectId); } catch { /* best-effort */ } }
    throw san(err, "mobile.provision");
  }
}

export async function rollback(input: ExpoRollbackInput, client: ExpoApiClient): Promise<void> {
  const { companyId, projectId } = input;
  const i = await store.getIntegration(companyId, PROVIDER_KEY);
  if (!i) return;
  try { await client.deleteProject(projectId); } catch (err: unknown) { throw san(err, "mobile.rollback"); }
  await rem(companyId);
  await appendAuditLog(companyId, "system", "mobile.rollback", "expo_project", projectId, `Rolled back EAS project ${projectId}`);
}

export async function getStatus(companyId: string): Promise<ExpoProvisionedResource | null> {
  return load(companyId);
}
