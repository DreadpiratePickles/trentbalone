import {
  createGbrainClient,
  resolveGbrainConnection,
  type GbrainClient,
  type GbrainIngestResult,
  type GbrainRecallResult,
} from "@/lib/gbrain/gbrain-client";
import { store } from "@/lib/store";

export type GbrainMemoryDeps = { client?: GbrainClient };

export type IngestMissionMemoryInput = {
  companyId: string;
  runId: string;
  objective: string;
  markdown: string;
  documentId?: string;
};

export async function ingestMissionMemory(
  input: IngestMissionMemoryInput,
  deps: GbrainMemoryDeps = {},
): Promise<GbrainIngestResult> {
  const client = deps.client ?? createGbrainClient(await resolveGbrainConnection(input.companyId));
  return client.ingest({
    companyId: input.companyId,
    runId: input.runId,
    title: `Agent mission memory log: ${input.objective}`,
    content: input.markdown,
    source: `agent-mission:${input.runId}`,
    tags: ["agent_mission", "memory_log"],
  });
}

export type RecallMissionContextInput = {
  companyId: string;
  objective: string;
  limit?: number;
};

export async function recallMissionContext(
  input: RecallMissionContextInput,
  deps: GbrainMemoryDeps = {},
): Promise<GbrainRecallResult> {
  const limit = input.limit ?? 5;
  const client = deps.client ?? createGbrainClient(await resolveGbrainConnection(input.companyId));

  if (client.connected) {
    const remote = await client.recall({ companyId: input.companyId, query: input.objective, limit });
    if (remote.status === "ok") return remote;
  }

  return localRecall(input.companyId, input.objective, limit);
}

// Local fallback: the company's own past mission memory is the brain when no
// external GBrain sidecar is connected (or the sidecar is unreachable).
async function localRecall(companyId: string, objective: string, limit: number): Promise<GbrainRecallResult> {
  const results = (await store.searchMemory(companyId, objective))
    .filter((item) => item.score > 0)
    .slice(0, limit);

  if (results.length === 0) {
    return {
      status: "ok",
      source: "local",
      answer: "No prior mission memory matched this objective. Treat this as a first-time mission.",
      citations: [],
      gaps: ["No prior mission memory found for this objective."],
    };
  }

  const answer = [
    `Recalled ${results.length} prior memory item(s) relevant to "${objective}":`,
    ...results.map((item) => `- ${item.title}: ${item.excerpt}`),
  ].join("\n");

  return {
    status: "ok",
    source: "local",
    answer,
    citations: results.map((item) => ({ id: item.id, title: item.title, excerpt: item.excerpt })),
    gaps: [],
  };
}
