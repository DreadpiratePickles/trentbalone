import { describe, expect, it } from "vitest";
import { buildApiOnlyTierDescriptor, listOpenAiCompatibleModels } from "@/lib/ai-proxy/access-tier";

describe("AI proxy access tier", () => {
  it("describes API-only capabilities, pricing, and limits", () => {
    const tier = buildApiOnlyTierDescriptor();

    expect(tier.capabilities).toEqual(["chat.completions", "embeddings", "rerank", "image.generation"]);
    expect(tier.limits.monthlyTokens).toBeGreaterThan(0);
    expect(tier.pricing.unit).toBe("token");
  });

  it("lists OpenAI-compatible models", () => {
    const models = listOpenAiCompatibleModels();

    expect(models.data.map((model) => model.id)).toContain("trent-sonnet");
    expect(models.data[0]).toMatchObject({ object: "model", owned_by: "trent" });
  });
});
