import { describe, expect, it } from "vitest";
import { WIKI_CLIENT_CAPABILITIES } from "@/components/wiki-client-capabilities";

describe("Trench Wiki client contract", () => {
  it("declares DeepWiki-class browsing, citations, diagrams, diffs, freshness, and search handoff", () => {
    expect(WIKI_CLIENT_CAPABILITIES.layout).toEqual(["tree", "pages", "diagram", "versions", "freshness"]);
    expect(WIKI_CLIENT_CAPABILITIES.controls).toEqual(expect.arrayContaining(["page_browse", "source_citations", "mermaid_diagram", "version_diff", "freshness_budget_telemetry", "grounded_search"]));
    expect(WIKI_CLIENT_CAPABILITIES.searchHandoff).toBe("phase_18_grounded_search");
  });
});
