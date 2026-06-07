import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock store so the test suite doesn't need a real database connection.
const { mockGetCompany, mockAddUsage, mockListUsage } = vi.hoisted(() => {
  const log: Array<Record<string, unknown>> = [];
  return {
    mockGetCompany: vi.fn().mockResolvedValue({ id: "company_trent_demo", name: "Demo" }),
    mockAddUsage: vi.fn().mockImplementation((row: Record<string, unknown>) => {
      log.push(row);
      return Promise.resolve();
    }),
    mockListUsage: vi.fn().mockImplementation(() => Promise.resolve([...log])),
  };
});

vi.mock("@/lib/store", () => ({
  store: {
    getCompany: mockGetCompany,
    addUsage: mockAddUsage,
    listUsage: mockListUsage,
  },
}));

import { store } from "@/lib/store";
import {
  assertProxyQuotaAvailable,
  authenticateProxyApiKey,
  hashProxyApiKey,
  maskProxyApiKey,
  recordProxyUsage,
  registerProxyApiKey,
  resetProxyApiKeysForTest,
} from "@/lib/ai-proxy/api-keys";

describe("AI proxy API keys", () => {
  beforeEach(() => {
    resetProxyApiKeysForTest();
  });

  it("hashes and masks API keys without returning raw key material", () => {
    const first = hashProxyApiKey("sk-trent-test");
    const second = hashProxyApiKey("sk-trent-test");

    expect(first).toBe(second);
    expect(first).not.toContain("sk-trent-test");
    expect(maskProxyApiKey("sk-trent-test")).toBe("sk-t...test");
  });

  it("authenticates active bearer keys with company, key, scopes, and tier", async () => {
    const record = registerProxyApiKey({
      companyId: "company_trent_demo",
      rawKey: "sk-trent-live",
      name: "Production",
      scopes: ["chat", "embeddings"],
      tier: "api_only",
    });

    const auth = await authenticateProxyApiKey("Bearer sk-trent-live");

    expect(auth).toMatchObject({
      companyId: "company_trent_demo",
      keyId: record.keyId,
      scopes: ["chat", "embeddings"],
      tier: "api_only",
    });
    expect(auth?.maskedKey).toBe("sk-t...live");
  });

  it("rejects inactive, revoked, and malformed keys without revealing existence", async () => {
    registerProxyApiKey({
      companyId: "company_trent_demo",
      rawKey: "sk-trent-revoked",
      name: "Revoked",
      scopes: ["chat"],
      tier: "api_only",
      status: "revoked",
    });

    await expect(authenticateProxyApiKey("sk-trent-revoked")).resolves.toBeNull();
    await expect(authenticateProxyApiKey("Bearer sk-trent-revoked")).resolves.toBeNull();
    await expect(authenticateProxyApiKey("Bearer sk-trent-missing")).resolves.toBeNull();
  });

  it("enforces per-key quota and returns retryAfterSeconds when exhausted", async () => {
    const key = registerProxyApiKey({
      companyId: "company_trent_demo",
      rawKey: "sk-trent-quota",
      name: "Quota",
      scopes: ["chat"],
      tier: "api_only",
      quota: { requestsPerWindow: 1, windowSeconds: 60, monthlyTokens: 20 },
    });

    await expect(assertProxyQuotaAvailable(key, { tokens: 10 })).resolves.toEqual({ ok: true });
    await expect(assertProxyQuotaAvailable(key, { tokens: 10 })).resolves.toMatchObject({
      ok: false,
      retryAfterSeconds: 60,
    });
  });

  it("records proxy usage metadata without raw prompt text", async () => {
    await store.getCompany("company_trent_demo");
    const key = registerProxyApiKey({
      companyId: "company_trent_demo",
      rawKey: "sk-trent-usage",
      name: "Usage",
      scopes: ["chat"],
      tier: "api_only",
    });

    await recordProxyUsage(key, {
      endpoint: "chat.completions",
      provider: "anthropic",
      model: "claude-sonnet",
      inputTokens: 12,
      outputTokens: 8,
      amountCents: 1,
    });

    const usage = await store.listUsage("company_trent_demo");
    expect(usage[0]).toMatchObject({
      category: "llm",
      amountCents: 1,
      metadata: {
        proxyKeyId: key.keyId,
        endpoint: "chat.completions",
        inputTokens: 12,
        outputTokens: 8,
      },
    });
    expect(JSON.stringify(usage[0].metadata)).not.toContain("prompt");
  });
});
