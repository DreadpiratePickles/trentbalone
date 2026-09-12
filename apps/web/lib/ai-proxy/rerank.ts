export type NormalizedRerankRequest = {
  model: string;
  query: string;
  documents: string[];
};

export function getRerankProviderPolicy() {
  return {
    providers: [
      { provider: "cohere", liveCredentialEnv: "COHERE_API_KEY" },
      { provider: "voyage", liveCredentialEnv: "VOYAGE_API_KEY" },
      { provider: "local", liveCredentialEnv: null },
    ],
  };
}

export function normalizeRerankRequest(body: unknown): NormalizedRerankRequest {
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const query = typeof record.query === "string" ? record.query.trim() : "";
  const documents = Array.isArray(record.documents)
    ? record.documents
      .filter((doc): doc is string => typeof doc === "string" && Boolean(doc.trim()))
      .map((doc) => doc.trim())
    : [];
  if (!query || documents.length === 0) throw new Error("query_and_documents_required");
  return {
    model: typeof record.model === "string" && record.model.trim() ? record.model.trim() : "trent-rerank",
    query,
    documents,
  };
}

export async function buildRerankResponse(input: { companyId: string; request: NormalizedRerankRequest }) {
  const results = input.request.documents
    .map((document, index) => ({
      index,
      document,
      relevance_score: score(input.request.query, document),
    }))
    .sort((a, b) => b.relevance_score - a.relevance_score);

  const inputTokens = estimateTokens(`${input.request.query} ${input.request.documents.join(" ")}`);
  return {
    provider: "local" as const,
    inputTokens,
    outputTokens: 0,
    amountCents: 1,
    response: {
      model: input.request.model,
      results,
      usage: { prompt_tokens: inputTokens, total_tokens: inputTokens },
    },
  };
}

function score(query: string, document: string): number {
  const terms = new Set(query.toLowerCase().split(/\s+/).filter(Boolean));
  const docTerms = document.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = docTerms.filter((term) => terms.has(term)).length;
  return Number((matches / Math.max(1, docTerms.length) + matches * 0.1).toFixed(6));
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.trim().split(/\s+/).filter(Boolean).length * 1.35));
}
