import { createHash } from "node:crypto";
import { routeModel } from "@/lib/model-gateway";

export type NormalizedEmbeddingRequest = {
  model: string;
  inputs: string[];
};

export function normalizeEmbeddingRequest(body: unknown): NormalizedEmbeddingRequest {
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const input = record.input;
  const inputs = Array.isArray(input) ? input : [input];
  const normalized = inputs
    .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    .map((item) => item.trim());
  if (normalized.length === 0) throw new Error("input_required");
  return {
    model: typeof record.model === "string" && record.model.trim() ? record.model.trim() : "trent-embed",
    inputs: normalized,
  };
}

export async function buildEmbeddingResponse(input: { companyId: string; request: NormalizedEmbeddingRequest }) {
  const route = routeModel({ seat: "analyst", taskTier: "triage", reversibility: "reversible", qualityPolicy: "cheap" });
  const promptTokens = input.request.inputs.reduce((sum, item) => sum + estimateTokens(item), 0);
  return {
    route,
    inputTokens: promptTokens,
    amountCents: 1,
    response: {
      object: "list",
      model: input.request.model,
      data: input.request.inputs.map((item, index) => ({
        object: "embedding",
        index,
        embedding: deterministicVector(`${input.companyId}:${item}`),
      })),
      usage: {
        prompt_tokens: promptTokens,
        total_tokens: promptTokens,
      },
    },
  };
}

function deterministicVector(text: string): number[] {
  const digest = createHash("sha256").update(text).digest();
  return Array.from(digest.subarray(0, 8)).map((byte) => Number(((byte - 128) / 128).toFixed(6)));
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.trim().split(/\s+/).filter(Boolean).length * 1.35));
}
