import {
  buildSourceCoverage,
  formatSourceCoverage,
  formatSourceDocumentsBlock,
  selectRelevantDocuments,
  type CoverageDocument,
  type SourceCoverage,
} from "@/lib/source-coverage";
import { semanticSearch } from "@/lib/wiki-embeddings";

export type GroundedSourceDocument = CoverageDocument & {
  sourceKind: "document" | "wiki";
  path?: string;
  score?: number;
};

export type GroundedSourceContext = {
  documents: GroundedSourceDocument[];
  coverage: SourceCoverage;
  sourceDocuments?: string;
  sourceCoverage?: string;
};

export async function retrieveGroundedSourceDocuments(input: {
  companyId: string;
  query: string;
  documents: CoverageDocument[];
  documentLimit?: number;
  wikiLimit?: number;
}): Promise<GroundedSourceDocument[]> {
  const documentLimit = input.documentLimit ?? 6;
  const wikiLimit = input.wikiLimit ?? 6;
  const query = input.query.trim();
  const rankedDocs = selectRelevantDocuments(query, input.documents, documentLimit)
    .map((doc): GroundedSourceDocument => ({
      ...doc,
      sourceKind: "document",
    }));

  const wikiHits = query
    ? await semanticSearch({ companyId: input.companyId, query, k: wikiLimit }).catch(() => [])
    : [];
  const wikiDocs = wikiHits
    .filter((hit) => hit.text.trim().length > 0)
    .map((hit): GroundedSourceDocument => ({
      id: `wiki:${hit.noteId}#${hit.chunkIdx}`,
      title: `${hit.title}${hit.path ? ` (${hit.path})` : ""}`,
      content: hit.text,
      type: "wiki_page",
      sourceKind: "wiki",
      path: hit.path,
      score: hit.score,
    }));

  const seen = new Set<string>();
  const merged: GroundedSourceDocument[] = [];
  for (const doc of [...rankedDocs, ...wikiDocs]) {
    const key = doc.id || `${doc.sourceKind}:${doc.title}:${doc.content.slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(doc);
  }
  return merged;
}

export async function buildGroundedSourceContext(input: {
  companyId: string;
  query: string;
  documents: CoverageDocument[];
  documentLimit?: number;
  wikiLimit?: number;
  maxCharsPerDoc?: number;
}): Promise<GroundedSourceContext> {
  const documents = await retrieveGroundedSourceDocuments(input);
  const coverage = buildSourceCoverage(input.query, documents);
  return {
    documents,
    coverage,
    sourceDocuments: documents.length
      ? formatSourceDocumentsBlock(documents, input.maxCharsPerDoc ?? 1500)
      : undefined,
    sourceCoverage: coverage.required.length ? formatSourceCoverage(coverage) : undefined,
  };
}
