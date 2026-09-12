import { createHash } from "node:crypto";
import { store } from "@/lib/store";
import { makeId, nowIso } from "@/lib/utils";
import type { ProxyApiKeyAuth, ProxyApiKeyRecord, ProxyQuota, ProxyScope, ProxyTier, ProxyUsageInput } from "./types";

const DEFAULT_QUOTA: ProxyQuota = {
  requestsPerWindow: 120,
  windowSeconds: 60,
  monthlyTokens: 1_000_000,
};

const keys = new Map<string, ProxyApiKeyRecord>();
const windows = new Map<string, { count: number; resetAt: number; tokens: number }>();

export function hashProxyApiKey(rawKey: string): string {
  return createHash("sha256").update(`trent-proxy:${rawKey}`).digest("hex");
}

export function maskProxyApiKey(rawKey: string): string {
  if (rawKey.length <= 8) return "****";
  return `${rawKey.slice(0, 4)}...${rawKey.slice(-4)}`;
}

export function registerProxyApiKey(input: {
  companyId: string;
  rawKey: string;
  name: string;
  scopes: ProxyScope[];
  tier: ProxyTier;
  status?: ProxyApiKeyRecord["status"];
  quota?: Partial<ProxyQuota>;
}): ProxyApiKeyAuth {
  const record: ProxyApiKeyRecord = {
    id: makeId("proxy_key"),
    companyId: input.companyId,
    name: input.name,
    keyHash: hashProxyApiKey(input.rawKey),
    maskedKey: maskProxyApiKey(input.rawKey),
    scopes: input.scopes,
    tier: input.tier,
    status: input.status ?? "active",
    quota: { ...DEFAULT_QUOTA, ...input.quota },
    createdAt: nowIso(),
  };
  keys.set(record.keyHash, record);
  return toAuth(record);
}

export async function authenticateProxyApiKey(authorization: string | null | undefined): Promise<ProxyApiKeyAuth | null> {
  const rawKey = parseBearer(authorization);
  if (!rawKey) return null;

  const record = keys.get(hashProxyApiKey(rawKey));
  if (!record || record.status !== "active") return null;
  record.lastUsedAt = nowIso();
  return toAuth(record);
}

export async function assertProxyQuotaAvailable(
  auth: ProxyApiKeyAuth,
  usage: { tokens: number },
  nowMs = Date.now()
): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }> {
  const current = windows.get(auth.keyId);
  const windowMs = auth.quota.windowSeconds * 1000;
  const bucket = !current || current.resetAt <= nowMs
    ? { count: 0, tokens: 0, resetAt: nowMs + windowMs }
    : current;

  if (bucket.count >= auth.quota.requestsPerWindow || bucket.tokens + usage.tokens > auth.quota.monthlyTokens) {
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - nowMs) / 1000)) };
  }

  bucket.count += 1;
  bucket.tokens += usage.tokens;
  windows.set(auth.keyId, bucket);
  return { ok: true };
}

export async function recordProxyUsage(auth: ProxyApiKeyAuth, input: ProxyUsageInput): Promise<void> {
  await store.addUsage({
    companyId: auth.companyId,
    category: "llm",
    amountCents: input.amountCents,
    description: `AI proxy ${input.endpoint}`,
    metadata: {
      proxyKeyId: auth.keyId,
      endpoint: input.endpoint,
      provider: input.provider,
      model: input.model,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      totalTokens: input.inputTokens + input.outputTokens,
    },
  });
}

export function resetProxyApiKeysForTest(): void {
  keys.clear();
  windows.clear();
}

function parseBearer(authorization: string | null | undefined): string | null {
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length).trim();
  return token.startsWith("sk-trent-") ? token : null;
}

function toAuth(record: ProxyApiKeyRecord): ProxyApiKeyAuth {
  return {
    companyId: record.companyId,
    keyId: record.id,
    maskedKey: record.maskedKey,
    scopes: record.scopes,
    tier: record.tier,
    quota: record.quota,
  };
}
