import { describe, expect, it } from "vitest";
import {
  createTavilyTrendResearchAdapter,
  persistMissionTrendResearch,
} from "@/lib/content/trend-research";
import type { AgentMissionRun, Artifact, Document } from "@/lib/types";

describe("createTavilyTrendResearchAdapter", () => {
  it("calls Tavily search with bounded recent-search parameters and maps sourced signals", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const adapter = createTavilyTrendResearchAdapter({
      apiKey: "tvly_test",
      endpoint: "https://api.tavily.test/search",
      fetchFn: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({
          query: "viral trend query",
          answer: "Short-form demos are gaining saves.",
          results: [{
            title: "Workflow demos are trending",
            url: "https://example.com/workflow-demos",
            content: "A source snippet about workflow demos.",
            score: 0.92,
            published_date: "2026-06-05",
          }],
          usage: { credits: 1 },
          request_id: "req_123",
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    const result = await adapter.search({
      objective: "make viral Trent content",
      query: "viral trend query",
      platforms: ["tiktok"],
      maxResults: 5,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.tavily.test/search");
    expect(calls[0].init.headers).toEqual(expect.objectContaining({
      authorization: "Bearer tvly_test",
      "content-type": "application/json",
    }));
    expect(JSON.parse(String(calls[0].init.body))).toEqual(expect.objectContaining({
      query: "viral trend query",
      search_depth: "basic",
      topic: "news",
      time_range: "week",
      max_results: 5,
      include_answer: "basic",
      include_usage: true,
    }));
    expect(result).toEqual({
      query: "viral trend query",
      answer: "Short-form demos are gaining saves.",
      usageCredits: 1,
      requestId: "req_123",
      signals: [{
        title: "Workflow demos are trending",
        url: "https://example.com/workflow-demos",
        content: "A source snippet about workflow demos.",
        score: 0.92,
        publishedAt: "2026-06-05",
      }],
    });
  });
});

describe("persistMissionTrendResearch", () => {
  it("persists a blocked research artifact and semantic document when no adapter is available", async () => {
    const createdArtifacts: Artifact[] = [];
    const createdDocuments: Document[] = [];
    const run = missionRun();

    const result = await persistMissionTrendResearch({
      run,
      platforms: ["x"],
      adapter: undefined,
      store: {
        async createArtifact(input) {
          const artifact = { ...input, id: "artifact_trend", createdAt: run.startedAt, updatedAt: run.startedAt } as Artifact;
          createdArtifacts.push(artifact);
          return artifact;
        },
        async createDocument(input) {
          const document = { ...input, id: "doc_trend", createdAt: run.startedAt, version: input.version ?? 1 } as Document;
          createdDocuments.push(document);
          return document;
        },
      },
    });

    expect(result.status).toBe("blocked");
    expect(result.blockers).toEqual(expect.arrayContaining([
      "TAVILY_API_KEY is missing; live viral trend search did not run.",
    ]));
    expect(createdDocuments).toEqual([
      expect.objectContaining({
        source: "agent-mission-trend-research:amr_test",
        memoryTier: "semantic",
        type: "research",
      }),
    ]);
    expect(createdArtifacts).toEqual([
      expect.objectContaining({
        status: "failed",
        storageKey: "agent-missions/amr_test/loops/viral-trend-research.md",
        createdByAgent: "analyst",
      }),
    ]);
  });
});

function missionRun(): AgentMissionRun {
  return {
    id: "amr_test",
    companyId: "company_test",
    objective: "Research viral X ideas for Trent",
    missionType: "content_social_ads",
    status: "running",
    trigger: "command",
    ownerSeat: "ceo",
    budgetCents: 5000,
    costCents: 0,
    approvalPolicy: {},
    modelPolicy: {},
    finalSummary: undefined,
    startedAt: "2026-06-06T00:00:00.000Z",
    completedAt: undefined,
    updatedAt: "2026-06-06T00:00:00.000Z",
  };
}
