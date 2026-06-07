import { describe, expect, it } from "vitest";
import { buildRerankResponse, getRerankProviderPolicy, normalizeRerankRequest } from "@/lib/ai-proxy/rerank";

describe("AI proxy rerank", () => {
  it("describes Cohere and Voyage provider policy", () => {
    expect(getRerankProviderPolicy().providers.map((provider) => provider.provider)).toEqual(["cohere", "voyage", "local"]);
  });

  it("returns deterministic ranked documents", async () => {
    const result = await buildRerankResponse({
      companyId: "co_1",
      request: normalizeRerankRequest({
        model: "trent-rerank",
        query: "alpha",
        documents: ["beta", "alpha beta", "gamma"],
      }),
    });

    expect(result.response.results[0]).toMatchObject({ index: 1, document: "alpha beta" });
    expect(result.response.results[0].relevance_score).toBeGreaterThan(result.response.results[2].relevance_score);
  });
});
