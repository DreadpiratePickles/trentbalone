import { decryptJson, encryptJson, maskSecret } from "@/lib/secrets";
import { store } from "@/lib/store";
import type { IntegrationStatus, ToolConnection } from "@/lib/types";

// Operator-level Google (Gmail + Calendar) connection. One connection for the
// operator, stored through the same credential boundary as company integrations
// but keyed under a reserved operator scope. The OAuth app credentials
// (clientId/clientSecret) are platform-level env vars; only the per-operator
// refresh token is stored encrypted. Reads feed GBrain memory; sends route
// through Trent's approval gates — nothing here executes on its own.

export const GOOGLE_PROVIDER = "Google";

// Reserved scope id for operator-level integrations (not a real company).
export const OPERATOR_SCOPE = "operator";

export const GOOGLE_DEFAULT_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
];

export type GoogleCredentials = {
  refreshToken: string;
  accessToken?: string;
  expiresAt?: string;
  scopes?: string[];
};

export type GoogleConnectionSource = "operator" | "env" | "missing";

export type GoogleConnection = {
  source: GoogleConnectionSource;
  refreshToken?: string;
  accessToken?: string;
  expiresAt?: string;
  scopes?: string[];
  clientId?: string;
  clientSecret?: string;
};

function appCredentials(): { clientId?: string; clientSecret?: string } {
  return {
    clientId: process.env.GOOGLE_CLIENT_ID?.trim() || undefined,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET?.trim() || undefined,
  };
}

export async function resolveGoogleConnection(scopeId: string = OPERATOR_SCOPE): Promise<GoogleConnection> {
  const app = appCredentials();
  const integration = await store.getIntegration(scopeId, GOOGLE_PROVIDER);
  if (integration?.status === "connected" && integration.encryptedData) {
    const credentials = safeDecrypt(integration.encryptedData);
    if (credentials?.refreshToken) {
      return {
        source: "operator",
        refreshToken: credentials.refreshToken,
        accessToken: credentials.accessToken,
        expiresAt: credentials.expiresAt,
        scopes: credentials.scopes ?? GOOGLE_DEFAULT_SCOPES,
        ...app,
      };
    }
  }

  const envRefresh = process.env.GOOGLE_REFRESH_TOKEN?.trim();
  if (envRefresh) {
    return { source: "env", refreshToken: envRefresh, scopes: GOOGLE_DEFAULT_SCOPES, ...app };
  }

  return { source: "missing", ...app };
}

export async function saveGoogleConnection(
  credentials: GoogleCredentials,
  scopeId: string = OPERATOR_SCOPE,
): Promise<ToolConnection> {
  if (!credentials.refreshToken) throw new Error("refreshToken is required");
  return store.upsertIntegration({
    companyId: scopeId,
    provider: GOOGLE_PROVIDER,
    scopes: credentials.scopes ?? GOOGLE_DEFAULT_SCOPES,
    status: "connected",
    encryptedData: encryptJson(credentials),
  });
}

export type GoogleConnectionStatus = {
  provider: string;
  status: IntegrationStatus;
  source: GoogleConnectionSource;
  scopes: string[];
  refreshToken?: string;
  expiresAt?: string;
};

export async function getGoogleConnectionStatus(scopeId: string = OPERATOR_SCOPE): Promise<GoogleConnectionStatus> {
  const connection = await resolveGoogleConnection(scopeId);
  if (connection.source === "missing") {
    return { provider: GOOGLE_PROVIDER, status: "needs_credentials", source: "missing", scopes: GOOGLE_DEFAULT_SCOPES };
  }
  return {
    provider: GOOGLE_PROVIDER,
    status: "connected",
    source: connection.source,
    scopes: connection.scopes ?? GOOGLE_DEFAULT_SCOPES,
    refreshToken: maskSecret(connection.refreshToken),
    expiresAt: connection.expiresAt,
  };
}

export async function revokeGoogleConnection(scopeId: string = OPERATOR_SCOPE): Promise<boolean> {
  const integration = await store.getIntegration(scopeId, GOOGLE_PROVIDER);
  if (!integration) return false;
  await store.revokeIntegration(integration.id);
  return true;
}

function safeDecrypt(encrypted: string): GoogleCredentials | undefined {
  try {
    return decryptJson<GoogleCredentials>(encrypted);
  } catch {
    return undefined;
  }
}
