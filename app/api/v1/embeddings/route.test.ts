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

describe("/v1/embeddings", () => {
  beforeEach(() => {
    resetProxyApiKeysForTest();
    vi.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue({ ok: true });
  });

  it("returns 401 for unauthorized keys", async () => {
    const res = await POST(new Request("http://x/v1/embeddings", { method: "POST", body: "{}" }));
    expect(res.status).toBe(401);
  });

  it("returns OpenAI-compatible embeddings through RLS", async () => {
    await store.getCompany("company_trent_demo");
    registerProxyApiKey({
      companyId: "company_trent_demo",
      rawKey: "sk-trent-embed",
      name: "Embeddings",
      scopes: ["embeddings"],
      tier: "api_only",
    });

    const res = await POST(new Request("http://x/v1/embeddings", {
      method: "POST",
      headers: { authorization: "Bearer sk-trent-embed" },
      body: JSON.stringify({ model: "trent-embed", input: ["alpha", "beta"] }),
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockWithRlsContext).toHaveBeenCalledWith("company_trent_demo", expect.any(Function));
    expect(body.data).toHaveLength(2);
    expect(body.data[0].embedding).toHaveLength(8);
  });
});
