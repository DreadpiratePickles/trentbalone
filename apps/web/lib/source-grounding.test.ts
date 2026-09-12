import { describe, expect, it, vi } from "vitest";

const mockWiki = vi.hoisted(() => ({
  semanticSearch: vi.fn(),
}));

vi.mock("@/lib/wiki-embeddings", () => mockWiki);

import { buildGroundedSourceContext, retrieveGroundedSourceDocuments } from "@/lib/source-grounding";

describe("source grounding", () => {
  it("merges relevant documents with semantic wiki chunks", async () => {
    mockWiki.semanticSearch.mockResolvedValueOnce([
      {
        noteId: "note_roadmap",
        title: "Roadmap Wiki",
        path: "wiki/roadmap.md",
        chunkIdx: 0,
        text: "Roadmap: launch import and Playwright verification first.",
        score: 0.91,
      },
    ]);

    const docs = await retrieveGroundedSourceDocuments({
      companyId: "co_1",
      query: "Use the roadmap and brand voice.",
      documents: [
        { id: "doc_brand", title: "Brand Voice", content: "Voice: direct, specific, candid.", type: "brief" },
      ],
    });

    expect(docs.map((doc) => doc.id)).toEqual(["doc_brand", "wiki:note_roadmap#0"]);
    expect(docs[1]).toMatchObject({
      sourceKind: "wiki",
      title: "Roadmap Wiki (wiki/roadmap.md)",
      type: "wiki_page",
    });
  });

  it("lets wiki chunks satisfy source coverage requirements", async () => {
    mockWiki.semanticSearch.mockResolvedValueOnce([
      {
        noteId: "note_roadmap",
        title: "Roadmap Wiki",
        path: "wiki/roadmap.md",
        chunkIdx: 0,
        text: "The roadmap prioritizes GitHub import before social automation.",
        score: 0.88,
      },
    ]);

    const context = await buildGroundedSourceContext({
      companyId: "co_1",
      query: "Audit the roadmap.",
      documents: [],
    });

    expect(context.sourceDocuments).toContain("[wiki:note_roadmap#0]");
    expect(context.sourceCoverage).toContain("Available: roadmap (doc wiki:note_roadmap#0)");
    expect(context.sourceCoverage).toContain("Missing: none");
  });
});
