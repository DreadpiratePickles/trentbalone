/**
 * The ranker `tool_search` uses: TF-IDF over the deferred catalog, cosine similarity, no network.
 *
 * `fleet-memory/lexical.ts` holds the same idea for memory recall, but nothing outside that
 * directory exports it and the two corpora are not the same shape: a tool is a NAME plus one
 * sentence, where a memory entry is prose. Names carry most of the signal here, so `mcp__acme__`
 * server prefixes are split on underscores and the name is weighted above the description —
 * a searcher who types the tool's own words must get that tool first.
 */

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "this", "that", "are", "was", "from", "into", "then", "than",
  "you", "not", "but", "can", "has", "have", "had", "will", "its", "all", "any", "use", "used",
  "when", "what", "which", "returns", "return", "tool", "call", "run",
]);

/** Splits on anything that is not a letter or a digit, so `mcp__acme__list_files` yields four terms. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 1 && !STOP_WORDS.has(term));
}

export interface RankableDocument {
  readonly id: string;
  /** Weighted above the body: the name is what a searcher half-remembers. */
  readonly title: string;
  readonly body: string;
}

export interface RankedDocument {
  readonly id: string;
  readonly score: number;
}

const TITLE_WEIGHT = 3;

function termCounts(document: RankableDocument): Map<string, number> {
  const counts = new Map<string, number>();
  const add = (term: string, weight: number): void => {
    counts.set(term, (counts.get(term) ?? 0) + weight);
  };
  for (const term of tokenize(document.title)) add(term, TITLE_WEIGHT);
  for (const term of tokenize(document.body)) add(term, 1);
  return counts;
}

/**
 * Scores every document against the query and returns the ones that share at least one term,
 * best first. A document sharing nothing scores zero and is dropped rather than ranked last:
 * a search that returns the whole catalog has told the caller nothing.
 */
export function rankDocuments(documents: readonly RankableDocument[], query: string): RankedDocument[] {
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0 || documents.length === 0) return [];

  const counts = documents.map(termCounts);
  const documentFrequency = new Map<string, number>();
  for (const bag of counts) {
    for (const term of bag.keys()) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }
  const idf = (term: string): number => Math.log(1 + documents.length / (1 + (documentFrequency.get(term) ?? 0)));

  const queryWeights = new Map<string, number>();
  for (const term of queryTerms) queryWeights.set(term, (queryWeights.get(term) ?? 0) + idf(term));
  const queryNorm = Math.sqrt([...queryWeights.values()].reduce((sum, weight) => sum + weight * weight, 0)) || 1;

  const ranked: RankedDocument[] = [];
  for (const [index, bag] of counts.entries()) {
    let dot = 0;
    let norm = 0;
    for (const [term, count] of bag) {
      const weight = count * idf(term);
      norm += weight * weight;
      const queryWeight = queryWeights.get(term);
      if (queryWeight !== undefined) dot += weight * queryWeight;
    }
    if (dot === 0) continue;
    ranked.push({ id: documents[index]!.id, score: dot / ((Math.sqrt(norm) || 1) * queryNorm) });
  }
  return ranked.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
