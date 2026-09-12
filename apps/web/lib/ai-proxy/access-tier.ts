export function buildApiOnlyTierDescriptor() {
  return {
    id: "api_only",
    name: "Trent AI Proxy API",
    capabilities: ["chat.completions", "embeddings", "rerank", "image.generation"],
    limits: {
      requestsPerMinute: 120,
      monthlyTokens: 1_000_000,
    },
    pricing: {
      unit: "token",
      platformFeePercent: 15,
      minimumMonthlyCents: 0,
    },
  };
}

export function listOpenAiCompatibleModels() {
  return {
    object: "list",
    data: [
      model("trent-haiku", "Fast triage and support workloads"),
      model("trent-sonnet", "Balanced operating work"),
      model("trent-opus", "High-stakes synthesis and review"),
      model("trent-embed", "Multi-provider embeddings"),
      model("trent-rerank", "Cohere/Voyage/local reranking"),
      model("trent-image", "Phase 4 image generation router"),
    ],
  };
}

function model(id: string, description: string) {
  return {
    id,
    object: "model",
    created: 1_779_753_600,
    owned_by: "trent",
    permission: [],
    trent: { description },
  };
}
