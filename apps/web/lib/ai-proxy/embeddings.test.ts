import { describe, expect, it } from "vitest";
import { buildEmbeddingResponse, normalizeEmbeddingRequest } from "@/lib/ai-proxy/embeddings";

describe("AI proxy embeddings", () => {
  it("normalizes single and array inputs", () => {
    expect(normalizeEmbeddingRequest({ model: "trent-embed", input: "hello" }).inputs).toEqual(["hello"]);
    expect(normalizeEmbeddingRequest({ model: "trent-embed", input: ["a", "b"] }).inputs).toEqual(["a", "b"]);
  });

  it("returns OpenAI-compatible deterministic embedding data and usage", async () => {
    const result = await buildEmbeddingResponse({
      companyId: "co_1",
      request: normalizeEmbeddingRequest({ model: "trent-embed", input: ["alpha", "beta"] }),
    });

    expect(result.response).toMatchObject({
      object: "list",
      model: "trent-embed",
      data: [
        { object: "embedding", index: 0, embedding: expect.any(Array) },
        { object: "embedding", index: 1, embedding: expect.any(Array) },
      ],
      usage: { prompt_tokens: expect.any(Number), total_tokens: expect.any(Number) },
    });
    expect(result.response.data[0].embedding).toHaveLength(8);
  });
});
