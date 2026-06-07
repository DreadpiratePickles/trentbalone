import { describe, expect, it } from "vitest";
import { ingestMissionMemory, recallMissionContext } from "@/lib/gbrain/gbrain-memory";
import type { GbrainClient } from "@/lib/gbrain/gbrain-client";
import { store } from "@/lib/store";
import { makeId } from "@/lib/utils";

function stubClient(overrides: Partial<GbrainClient>): GbrainClient {
  return {
    connected: true,
    ingest: async () => ({ status: "ingested", source: "sidecar", documentId: "doc_remote" }),
    recall: async () => ({ status: "ok", source: "sidecar", answer: "", citations: [], gaps: [] }),
    advise: async () => ({ status: "ok", source: "sidecar", guidance: "", clarifyingQuestions: [] }),
    ...overrides,
  };
}

async function seedMissionMemory(companyId: string, objective: string, content: string) {
  return store.createDocument({
    companyId,
    type: "agent_note",
    title: `Agent mission memory log: ${objective}`,
    content,
    source: `agent-mission:${makeId("amr")}`,
    memoryTier: "episodic",
  });
}

describe("recallMissionContext", () => {
  it("uses the local store brain when no sidecar is connected and prior memory exists", async () => {
    const companyId = makeId("co");
    await seedMissionMemory(companyId, "TikTok launch", "Prior TikTok launch leaned on build-in-public demos and tactical teardowns.");
    const result = await recallMissionContext({ companyId, objective: "Plan a TikTok launch campaign" });
    expect(result.status).toBe("ok");
    expect(result.source).toBe("local");
    expect(result.citations.length).toBeGreaterThan(0);
    expect(result.answer.toLowerCase()).toContain("tiktok");
  });

  it("reports a memory gap locally when there is no prior mission memory", async () => {
    const companyId = makeId("co");
    const result = await recallMissionContext({ companyId, objective: "Brand new objective with no history" });
    expect(result.source).toBe("local");
    expect(result.gaps.length).toBeGreaterThan(0);
  });

  it("uses the sidecar when a connected client is supplied", async () => {
    const companyId = makeId("co");
    const client = stubClient({
      connected: true,
      recall: async () => ({ status: "ok", source: "sidecar", answer: "Synthesized from GBrain.", citations: [{ id: "r1", title: "Launch A" }], gaps: ["no paid benchmark"] }),
    });
    const result = await recallMissionContext({ companyId, objective: "launch" }, { client });
    expect(result.source).toBe("sidecar");
    expect(result.answer).toBe("Synthesized from GBrain.");
  });

  it("falls back to the local brain when the sidecar errors", async () => {
    const companyId = makeId("co");
    await seedMissionMemory(companyId, "launch", "Prior launch insight about audience demand.");
    const client = stubClient({
      connected: true,
      recall: async () => ({ status: "error", source: "sidecar", answer: "", citations: [], gaps: [], detail: "boom" }),
    });
    const result = await recallMissionContext({ companyId, objective: "launch" }, { client });
    expect(result.source).toBe("local");
    expect(result.status).toBe("ok");
  });
});

describe("ingestMissionMemory", () => {
  it("returns not_connected when no sidecar is configured", async () => {
    const result = await ingestMissionMemory({
      companyId: makeId("co"),
      runId: makeId("amr"),
      objective: "launch",
      markdown: "# memory log",
    });
    expect(result.status).toBe("not_connected");
  });

  it("ingests into the sidecar when a connected client is supplied", async () => {
    let ingestedTitle = "";
    const client = stubClient({
      connected: true,
      ingest: async (input) => {
        ingestedTitle = input.title;
        return { status: "ingested", source: "sidecar", documentId: "doc_remote_2" };
      },
    });
    const result = await ingestMissionMemory(
      { companyId: makeId("co"), runId: "amr_9", objective: "launch", markdown: "# memory log" },
      { client },
    );
    expect(result.status).toBe("ingested");
    expect(result.documentId).toBe("doc_remote_2");
    expect(ingestedTitle).toContain("launch");
  });
});
