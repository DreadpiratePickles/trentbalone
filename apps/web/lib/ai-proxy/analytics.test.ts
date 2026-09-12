import { beforeEach, describe, expect, it } from "vitest";
import { store } from "@/lib/store";
import { summarizeProxyUsage } from "@/lib/ai-proxy/analytics";

describe("AI proxy analytics", () => {
  beforeEach(async () => {
    await store.getCompany("company_trent_demo");
  });

  it("aggregates usage by proxy key, endpoint, tokens, and cost", async () => {
    await store.addUsage({
      companyId: "company_trent_demo",
      category: "llm",
      amountCents: 3,
      description: "AI proxy chat.completions",
      metadata: { proxyKeyId: "proxy_key_1", endpoint: "chat.completions", inputTokens: 10, outputTokens: 5 },
    });
    await store.addUsage({
      companyId: "company_trent_demo",
      category: "llm",
      amountCents: 2,
      description: "AI proxy embeddings",
      metadata: { proxyKeyId: "proxy_key_1", endpoint: "embeddings", inputTokens: 8, outputTokens: 0 },
    });

    const summary = await summarizeProxyUsage("company_trent_demo", { keyId: "proxy_key_1" });

    expect(summary).toMatchObject({
      keyId: "proxy_key_1",
      requestCount: 2,
      inputTokens: 18,
      outputTokens: 5,
      amountCents: 5,
      endpoints: {
        "chat.completions": { requestCount: 1 },
        embeddings: { requestCount: 1 },
      },
    });
  });
});
