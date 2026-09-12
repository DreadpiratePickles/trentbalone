export const WIKI_CLIENT_CAPABILITIES = {
  layout: ["tree", "pages", "diagram", "versions", "freshness"],
  controls: ["page_browse", "source_citations", "mermaid_diagram", "version_diff", "freshness_budget_telemetry", "grounded_search"],
  searchHandoff: "phase_18_grounded_search",
} as const;
