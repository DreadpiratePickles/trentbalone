import { decryptJson, encryptJson, maskSecret } from "@/lib/secrets";
import { store } from "@/lib/store";
import type { ToolConnection } from "@/lib/types";
import type { CreativeApp } from "@/lib/platform-auth-readiness";

export const CREATIVE_APP_PROVIDERS: Record<CreativeApp, string> = {
  higgsfield: "Higgsfield",
  hyperframes: "HyperFrames",
  open_generative_ai: "Open Generative AI",
};

const CREATIVE_APP_ENV: Record<CreativeApp, string> = {
  higgsfield: "HIGGSFIELD_API_KEY",
  hyperframes: "HYPERFRAMES_API_KEY",
  open_generative_ai: "OPEN_GENERATIVE_AI_API_KEY",
};

export type CreativeConnectionInput = {
  app: CreativeApp;
  apiKey: string;
};

export type CreativeConnectionStatus = {
  id?: string;
  app: CreativeApp;
  provider: string;
  status: ToolConnection["status"];
  source: "company" | "env" | "missing";
  scopes: string[];
  apiKey?: string;
  lastCheckedAt?: string;
};

type CreativeCredentials = CreativeConnectionInput;

export function isCreativeApp(value: unknown): value is CreativeApp {
  return typeof value === "string" && value in CREATIVE_APP_PROVIDERS;
}

export function normalizeCreativeConnectionInput(input: Record<string, unknown>): CreativeConnectionInput & { companyId: string } {
  const companyId = typeof input.companyId === "string" ? input.companyId.trim() : "";
  const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  if (!companyId) throw new Error("companyId is required");
  if (!isCreativeApp(input.app)) throw new Error("app must be one of higgsfield, hyperframes, open_generative_ai");
  if (!apiKey) throw new Error("apiKey is required");
  return { companyId, app: input.app, apiKey };
}

export async function saveCreativeConnection(companyId: string, input: CreativeConnectionInput): Promise<ToolConnection> {
  return store.upsertIntegration({
    companyId,
    provider: CREATIVE_APP_PROVIDERS[input.app],
    scopes: ["creative:generate"],
    status: "connected",
    encryptedData: encryptJson({ app: input.app, apiKey: input.apiKey } satisfies CreativeCredentials),
  });
}

export async function getCreativeCredentialMap(companyId?: string): Promise<Partial<Record<CreativeApp, boolean>>> {
  const pairs = await Promise.all(
    creativeApps().map(async (app) => [app, await hasCreativeCredential(app, companyId)] as const),
  );
  return Object.fromEntries(pairs) as Partial<Record<CreativeApp, boolean>>;
}

export async function getCreativeApiKey(companyId: string, app: CreativeApp): Promise<string | undefined> {
  const connection = await store.getIntegration(companyId, CREATIVE_APP_PROVIDERS[app]);
  if (connection?.status === "connected" && connection.encryptedData) {
    const credentials = safeDecrypt(connection.encryptedData);
    if (credentials?.app === app && credentials.apiKey) return credentials.apiKey;
  }
  return envCredential(app);
}

export async function listCreativeConnectionStatuses(companyId: string): Promise<CreativeConnectionStatus[]> {
  return Promise.all(creativeApps().map((app) => connectionStatus(companyId, app)));
}

async function connectionStatus(companyId: string, app: CreativeApp): Promise<CreativeConnectionStatus> {
  const provider = CREATIVE_APP_PROVIDERS[app];
  const connection = await store.getIntegration(companyId, provider);
  if (connection?.status === "connected" && connection.encryptedData) {
    const credentials = safeDecrypt(connection.encryptedData);
    return {
      id: connection.id,
      app,
      provider,
      status: "connected",
      source: "company",
      scopes: connection.scopes,
      apiKey: maskSecret(credentials?.apiKey),
      lastCheckedAt: connection.lastCheckedAt,
    };
  }

  const envKey = envCredential(app);
  if (envKey) {
    return { app, provider, status: "connected", source: "env", scopes: ["creative:generate"], apiKey: maskSecret(envKey) };
  }

  return { app, provider, status: "needs_credentials", source: "missing", scopes: ["creative:generate"] };
}

async function hasCreativeCredential(app: CreativeApp, companyId?: string): Promise<boolean> {
  if (companyId) {
    const connection = await store.getIntegration(companyId, CREATIVE_APP_PROVIDERS[app]);
    if (connection?.status === "connected" && connection.encryptedData) return true;
  }
  return Boolean(envCredential(app));
}

function safeDecrypt(encrypted: string): CreativeCredentials | undefined {
  try {
    return decryptJson<CreativeCredentials>(encrypted);
  } catch {
    return undefined;
  }
}

function envCredential(app: CreativeApp) {
  return process.env[CREATIVE_APP_ENV[app]];
}

function creativeApps(): CreativeApp[] {
  return ["higgsfield", "hyperframes", "open_generative_ai"];
}
