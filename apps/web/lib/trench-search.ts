import type { MemorySearchResult } from "@/lib/types";
import type { WikiIndex, WikiPage } from "@/lib/trench-wiki";

export type SearchCorpusEntry = {
  id: string;
  title: string;
  text: string;
  sourceType: "wiki_page" | "memory";
  citation: string;
  href?: string;
  tenantScoped: true;
};

export type GroundedResult = SearchCorpusEntry & {
  score: number;
};

export type SearchTurn = {
  role: "user" | "assistant";
  content: string;
};

export const TRENCH_SEARCH_RETRIEVAL_CONTRACT = {
  embeddingsEndpoint: "/api/v1/embeddings",
  vectorStack: "reuse_phase_17_index",
  citationRequired: true,
  scope: "withRlsContext(companyId)",
} as const;

export function buildSearchCorpus(wiki: WikiIndex, memoryResults: MemorySearchResult[] = []): SearchCorpusEntry[] {
  const wikiEntries = wiki.pages.flatMap((page) => pageToCorpusEntries(page));
  const memoryEntries = memoryResults.map((result) => ({
    id: `memory:${result.id}`,
    title: result.title,
    text: result.excerpt,
    sourceType: "memory" as const,
    citation: `memory:${result.id}`,
    tenantScoped: true as const,
  }));
  return [...wikiEntries, ...memoryEntries];
}

export function retrieveGroundedResults(query: string, corpus: SearchCorpusEntry[], limit = 5): GroundedResult[] {
  const terms = tokenize(query);
  if (terms.length === 0) return [];

  return corpus
    .map((entry) => ({ ...entry, score: scoreEntry(terms, entry) }))
    .filter((entry) => entry.score > 0 && entry.citation)
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, limit);
}

export function buildGroundedAnswer(query: string, results: GroundedResult[], followUps: SearchTurn[] = []) {
  const cited = results.filter((result) => result.citation);
  if (cited.length === 0) {
    return {
      answer: "",
      citations: [] as string[],
      refusal: "No cited source supports an answer.",
      followUpContext: { turnsUsed: followUps.length },
    };
  }

  const citations = Array.from(new Set(cited.map((result) => result.citation)));
  const evidence = cited.slice(0, 3).map((result) => result.text.replace(/\s+/g, " ").slice(0, 180));
  return {
    answer: `Based on cited Trent sources: ${evidence.join(" ")}`,
    citations,
    refusal: undefined,
    followUpContext: {
      query,
      turnsUsed: followUps.length,
      previousUserTurn: followUps.filter((turn) => turn.role === "user").at(-1)?.content,
    },
  };
}

export function buildSearchUsageAnalytics(input: {
  companyId: string;
  apiKeyId?: string;
  query: string;
  resultCount: number;
  citationCount: number;
}) {
  return {
    companyId: input.companyId,
    apiKeyId: input.apiKeyId,
    queryLength: input.query.length,
    resultCount: input.resultCount,
    citationCount: input.citationCount,
    rateLimitScope: "company_and_key" as const,
    retrievalContract: TRENCH_SEARCH_RETRIEVAL_CONTRACT,
  };
}

function pageToCorpusEntries(page: WikiPage): SearchCorpusEntry[] {
  const links = page.sourceLinks.length ? page.sourceLinks : [{ label: page.slug, path: page.slug, line: 1 }];
  return links.map((link, index) => ({
    id: `wiki:${page.slug}:${index}`,
    title: page.title,
    text: `${page.title}\n${page.summary}`,
    sourceType: "wiki_page" as const,
    citation: link.label,
    href: `#${page.slug}`,
    tenantScoped: true as const,
  }));
}

function scoreEntry(terms: string[], entry: SearchCorpusEntry) {
  const haystack = `${entry.title} ${entry.text} ${entry.citation}`.toLowerCase();
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

function tokenize(value: string) {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 2);
}
