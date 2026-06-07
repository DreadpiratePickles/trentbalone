import type { ModelProvider } from "@/lib/model-gateway";

export type ProxyScope = "chat" | "embeddings" | "rerank" | "images" | "usage" | "models";
export type ProxyTier = "internal" | "api_only" | "enterprise";
export type ProxyKeyStatus = "active" | "inactive" | "revoked";

export type ProxyQuota = {
  requestsPerWindow: number;
  windowSeconds: number;
  monthlyTokens: number;
};

export type ProxyApiKeyRecord = {
  id: string;
  companyId: string;
  name: string;
  keyHash: string;
  maskedKey: string;
  scopes: ProxyScope[];
  tier: ProxyTier;
  status: ProxyKeyStatus;
  quota: ProxyQuota;
  createdAt: string;
  lastUsedAt?: string;
};

export type ProxyApiKeyAuth = {
  companyId: string;
  keyId: string;
  maskedKey: string;
  scopes: ProxyScope[];
  tier: ProxyTier;
  quota: ProxyQuota;
};

export type ProxyUsageInput = {
  endpoint: string;
  provider: ModelProvider | "cohere" | "voyage" | "local";
  model: string;
  inputTokens: number;
  outputTokens: number;
  amountCents: number;
};
