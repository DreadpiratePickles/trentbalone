import { describe, expect, it } from "vitest";
import {
  TRENCH_SEARCH_RETRIEVAL_CONTRACT,
  buildGroundedAnswer,
  buildSearchCorpus,
  buildSearchUsageAnalytics,
  retrieveGroundedResults,
} from "@/lib/trench-search";
import type { WikiIndex } from "@/lib/trench-wiki";
import type { MemorySearchResult } from "@/lib/types";

const wiki = {
  companyId: "co_1",
  generatedAt: "2026-05-29T00:00:00.000Z",
  tree: { nodes: [] },
  pages: [
    {
      slug: "billing-route",
      title: "Billing route",
      summary: "Payment capture requires idempotency keys and audit logging.",
      sourceId: "src_1",
      sourceKind: "file",
      sourceLinks: [{ path: "app/api/payments/route.ts", line: 12, label: "app/api/payments/route.ts:12" }],
      checksum: "abc",
      updatedAt: "2026-05-29T00:00:00.000Z",
    },
    {
      slug: "brand-memory",
      title: "Brand memory",
      summary: "Voice memory stores creative lessons for future campaigns.",
      sourceId: "src_2",
      sourceKind: "memory",
      sourceLinks: [{ path: "memory/doc_1.md", line: 1, label: "memory/doc_1.md:1" }],
      checksum: "def",
      updatedAt: "2026-05-29T00:01:00.000Z",
    },
  ],
  diagrams: [],
  versions: { diff: { added: [], changed: [], removed: [] } },
  freshness: { generatedAt: "2026-05-29T00:00:00.000Z", ageSeconds: 0, isStale: false, sourceCount: 2, chunkCount: 2, costTelemetry: { usageCents: 25, budgetCents: 1000, remainingCents: 975 } },
} satisfies WikiIndex;

const memoryResults = [
  {
    id: "mem_1",
    kind: "document",
    title: "Payment decision",
    excerpt: "Stripe payment capture must be idempotent and auditable.",
    createdAt: "2026-05-29T00:02:00.000Z",
    score: 2,
  },
] satisfies MemorySearchResult[];

describe("Trench Search domain", () => {
  it("builds a corpus from wiki pages and memory results with citations", () => {
    const corpus = buildSearchCorpus(wiki, memoryResults);

    expect(corpus).toHaveLength(3);
    expect(corpus[0]).toMatchObject({
      sourceType: "wiki_page",
      citation: "app/api/payments/route.ts:12",
      tenantScoped: true,
    });
    expect(corpus[2]).toMatchObject({
      sourceType: "memory",
      citation: "memory:mem_1",
    });
  });

  it("retrieves grounded results ranked by query overlap", () => {
    const results = retrieveGroundedResults("How do payments stay idempotent?", buildSearchCorpus(wiki, memoryResults), 2);

    expect(results).toHaveLength(2);
    expect(results[0]?.citation).toBe("app/api/payments/route.ts:12");
    expect(results[0]?.score).toBeGreaterThan(0);
  });

  it("refuses to answer when no citations are available", () => {
    const answer = buildGroundedAnswer("What is the roadmap?", []);

    expect(answer.answer).toBe("");
    expect(answer.refusal).toContain("No cited source");
    expect(answer.citations).toEqual([]);
  });

  it("builds answers only from cited retrieval results and carries follow-up context", () => {
    const results = retrieveGroundedResults("payment audit logging", buildSearchCorpus(wiki, memoryResults), 2);
    const answer = buildGroundedAnswer("Does payment capture need audit logging?", results, [
      { role: "user", content: "What about payments?" },
      { role: "assistant", content: "Payments use Stripe." },
    ]);

    expect(answer.answer).toContain("payment");
    expect(answer.citations).toEqual(expect.arrayContaining(["app/api/payments/route.ts:12"]));
    expect(answer.followUpContext.turnsUsed).toBe(2);
  });

  it("surfaces per-company usage analytics and embedding reuse contract", () => {
    const analytics = buildSearchUsageAnalytics({
      companyId: "co_1",
      apiKeyId: "key_1",
      query: "payment audit",
      resultCount: 2,
      citationCount: 2,
    });

    expect(analytics).toMatchObject({
      companyId: "co_1",
      apiKeyId: "key_1",
      resultCount: 2,
      citationCount: 2,
      rateLimitScope: "company_and_key",
    });
    expect(TRENCH_SEARCH_RETRIEVAL_CONTRACT.embeddingsEndpoint).toBe("/api/v1/embeddings");
    expect(TRENCH_SEARCH_RETRIEVAL_CONTRACT.vectorStack).toBe("reuse_phase_17_index");
  });
});
