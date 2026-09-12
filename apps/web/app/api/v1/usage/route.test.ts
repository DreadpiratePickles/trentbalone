import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockWithRlsContext } = vi.hoisted(() => ({
  mockWithRlsContext: vi.fn(async (_companyId: string, fn: () => Promise<Response>) => fn()),
}));

vi.mock("@/lib/with-rls", () => ({ withRlsContext: mockWithRlsContext }));

import { registerProxyApiKey, resetProxyApiKeysForTest } from "@/lib/ai-proxy/api-keys";
import { store } from "@/lib/store";
import { GET } from "./route";

describe("/v1/usage", () => {
  beforeEach(() => {
    resetProxyApiKeysForTest();
    vi.clearAllMocks();
  });

  it("returns bearer-key scoped usage analytics", async () => {
    await store.getCompany("company_trent_demo");
    const key = registerProxyApiKey({
      companyId: "company_trent_demo",
      rawKey: "sk-trent-usage-route",
      name: "Usage",
      scopes: ["usage"],
      tier: "api_only",
    });
    await store.addUsage({
      companyId: "company_trent_demo",
      category: "llm",
      amountCents: 4,
      description: "AI proxy chat.completions",
      metadata: { proxyKeyId: key.keyId, endpoint: "chat.completions", inputTokens: 10, outputTokens: 10 },
    });

    const res = await GET(new Request("http://x/v1/usage", { headers: { authorization: "Bearer sk-trent-usage-route" } }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockWithRlsContext).toHaveBeenCalledWith("company_trent_demo", expect.any(Function));
    expect(body.summary).toMatchObject({ keyId: key.keyId, requestCount: 1, amountCents: 4 });
  });
});
