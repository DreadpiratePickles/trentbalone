import { encryptJson, maskSecret } from "@/lib/secrets";
import { store } from "@/lib/store";
import { GBRAIN_PROVIDER, resolveGbrainConnection } from "@/lib/gbrain/gbrain-client";
import type { IntegrationStatus, ToolConnection } from "@/lib/types";

const GBRAIN_SCOPES = ["memory:read", "memory:write"];

export type GbrainConnectionInput = {
  companyId: string;
  baseUrl: string;
  apiKey?: string;
};

export function normalizeGbrainConnectionInput(input: Record<string, unknown>): GbrainConnectionInput {
  const companyId = typeof input.companyId === "string" ? input.companyId.trim() : "";
  const baseUrl = typeof input.baseUrl === "string" ? input.baseUrl.trim() : "";
  const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  if (!companyId) throw new Error("companyId is required");
  if (!isHttpUrl(baseUrl)) throw new Error("baseUrl must be a valid http(s) URL");
  return { companyId, baseUrl, ...(apiKey ? { apiKey } : {}) };
}

export async function saveGbrainConnection(
  companyId: string,
  input: { baseUrl: string; apiKey?: string },
): Promise<ToolConnection> {
  return store.upsertIntegration({
    companyId,
    provider: GBRAIN_PROVIDER,
    scopes: GBRAIN_SCOPES,
    status: "connected",
    encryptedData: encryptJson({ baseUrl: input.baseUrl, apiKey: input.apiKey }),
  });
}

export type GbrainConnectionStatus = {
  provider: string;
  status: IntegrationStatus;
  source: "company" | "env" | "missing";
  scopes: string[];
  baseUrl?: string;
  apiKey?: string;
};

export async function getGbrainConnectionStatus(companyId: string): Promise<GbrainConnectionStatus> {
  const connection = await resolveGbrainConnection(companyId);
  if (connection.source === "missing") {
    return { provider: GBRAIN_PROVIDER, status: "needs_credentials", source: "missing", scopes: GBRAIN_SCOPES };
  }
  return {
    provider: GBRAIN_PROVIDER,
    status: "connected",
    source: connection.source,
    scopes: GBRAIN_SCOPES,
    baseUrl: connection.baseUrl,
    apiKey: maskSecret(connection.apiKey),
  };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
