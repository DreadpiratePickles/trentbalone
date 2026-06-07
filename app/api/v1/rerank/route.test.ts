import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCheckRateLimit, mockWithRlsContext } = vi.hoisted(() => ({
  mockCheckRateLimit: vi.fn(),
  mockWithRlsContext: vi.fn(async (_companyId: string, fn: () => Promise<Response>) => fn()),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mockCheckRateLimit,
  rateLimitExceeded: (retryAfterSeconds: number) => Response.json({ error: "rate_limit_exceeded", retryAfterSeconds }, { status: 429 }),
}));
vi.mock("@/lib/with-rls", () => ({ withRlsContext: mockWithRlsContext }));

import { registerProxyApiKey, resetProxyApiKeysForTest } from "@/lib/ai-proxy/api-keys";
import { store } from "@/lib/store";
import { POST } from "./route";

describe("/v1/rerank", () => {
  beforeEach(() => {
    resetProxyApiKeysForTest();
    vi.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue({ ok: true });
  });

  it("enforces bearer auth", async () => {
    const res = await POST(new Request("http://x/v1/rerank", { method: "POST", body: "{}" }));
    expect(res.status).toBe(401);
  });

  it("reranks documents with quota, usage, and RLS", async () => {
    await store.getCompany("company_trent_demo");
    registerProxyApiKey({
      companyId: "company_trent_demo",
      rawKey: "sk-trent-rerank",
      name: "Rerank",
      scopes: ["rerank"],
      tier: "api_only",
    });

    const res = await POST(new Request("http://x/v1/rerank", {
      method: "POST",
      headers: { authorization: "Bearer sk-trent-rerank" },
      body: JSON.stringify({ query: "alpha", documents: ["beta", "alpha beta"] }),
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockWithRlsContext).toHaveBeenCalledWith("company_trent_demo", expect.any(Function));
    expect(body.results[0]).toMatchObject({ index: 1, document: "alpha beta" });
  });
});
