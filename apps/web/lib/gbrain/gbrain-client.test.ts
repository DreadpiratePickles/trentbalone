import { afterEach, describe, expect, it } from "vitest";
import {
  createGbrainClient,
  resolveGbrainConnection,
  type GbrainFetch,
} from "@/lib/gbrain/gbrain-client";
import { store } from "@/lib/store";
import { encryptJson } from "@/lib/secrets";
import { makeId } from "@/lib/utils";

afterEach(() => {
  delete process.env.GBRAIN_URL;
  delete process.env.GBRAIN_API_KEY;
});

function jsonResponse(status: number, body: unknown): ReturnType<GbrainFetch> {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });
}

function recordingFetch(impl: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => ReturnType<GbrainFetch>) {
  const calls: { url: string; init: { method: string; headers: Record<string, string>; body: string } }[] = [];
  const fetchImpl: GbrainFetch = (url, init) => {
    calls.push({ url, init });
    return impl(url, init);
  };
  return { calls, fetchImpl };
}

describe("resolveGbrainConnection", () => {
  it("returns missing when no company integration and no env", async () => {
    const connection = await resolveGbrainConnection(makeId("co"));
    expect(connection.source).toBe("missing");
    expect(connection.baseUrl).toBeUndefined();
  });

  it("returns env source when GBRAIN_URL and GBRAIN_API_KEY are set", async () => {
    process.env.GBRAIN_URL = "https://gbrain.example";
    process.env.GBRAIN_API_KEY = "gb_env_key";
    const connection = await resolveGbrainConnection(makeId("co"));
    expect(connection.source).toBe("env");
    expect(connection.baseUrl).toBe("https://gbrain.example");
    expect(connection.apiKey).toBe("gb_env_key");
  });

  it("prefers a connected company integration over env", async () => {
    const companyId = makeId("co");
    await store.upsertIntegration({
      companyId,
      provider: "GBrain",
      scopes: ["memory:read", "memory:write"],
      status: "connected",
      encryptedData: encryptJson({ baseUrl: "https://co.gbrain.example", apiKey: "gb_company_key" }),
    });
    process.env.GBRAIN_URL = "https://gbrain.example";
    process.env.GBRAIN_API_KEY = "gb_env_key";
    const connection = await resolveGbrainConnection(companyId);
    expect(connection.source).toBe("company");
    expect(connection.baseUrl).toBe("https://co.gbrain.example");
    expect(connection.apiKey).toBe("gb_company_key");
  });
});

describe("gbrain client (not connected)", () => {
  const client = createGbrainClient({ source: "missing" });

  it("reports not connected", () => {
    expect(client.connected).toBe(false);
  });

  it("returns not_connected from recall without calling the transport", async () => {
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse(200, {}));
    const connected = createGbrainClient({ source: "missing" }, fetchImpl);
    const result = await connected.recall({ companyId: "co_1", query: "past launches" });
    expect(result.status).toBe("not_connected");
    expect(result.source).toBe("none");
    expect(calls).toHaveLength(0);
  });
});

describe("gbrain client (connected)", () => {
  const connection = { source: "env" as const, baseUrl: "https://gbrain.example", apiKey: "gb_secret_key" };

  it("ingests a memory document with bearer auth", async () => {
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse(201, { documentId: "doc_remote_1" }));
    const client = createGbrainClient(connection, fetchImpl);
    const result = await client.ingest({
      companyId: "co_1",
      runId: "amr_1",
      title: "Mission log",
      content: "## results",
      source: "agent-mission:amr_1",
      tags: ["mission"],
    });
    expect(result.status).toBe("ingested");
    expect(result.source).toBe("sidecar");
    expect(result.documentId).toBe("doc_remote_1");
    expect(calls[0].url).toBe("https://gbrain.example/ingest");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers.Authorization).toBe("Bearer gb_secret_key");
  });

  it("recalls a synthesized answer with citations and gaps", async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse(200, {
        answer: "Prior launches leaned on build-in-public proof.",
        citations: [{ id: "doc_1", title: "Launch A", excerpt: "..." }],
        gaps: ["No paid-spend benchmark yet."],
      }),
    );
    const client = createGbrainClient(connection, fetchImpl);
    const result = await client.recall({ companyId: "co_1", query: "how did past launches go" });
    expect(result.status).toBe("ok");
    expect(result.source).toBe("sidecar");
    expect(result.answer).toContain("build-in-public");
    expect(result.citations).toHaveLength(1);
    expect(result.gaps).toEqual(["No paid-spend benchmark yet."]);
  });

  it("returns advisory guidance for an agent ping", async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse(200, {
        guidance: "Lead with the analyst seat; prior audience data is thin.",
        suggestedNextStep: "analyst",
        clarifyingQuestions: ["Which platform is the priority?"],
      }),
    );
    const client = createGbrainClient(connection, fetchImpl);
    const result = await client.advise({ companyId: "co_1", objective: "launch", question: "what next" });
    expect(result.status).toBe("ok");
    expect(result.suggestedNextStep).toBe("analyst");
    expect(result.clarifyingQuestions).toHaveLength(1);
  });

  it("returns an error status without leaking the api key when the transport throws", async () => {
    const fetchImpl: GbrainFetch = () => Promise.reject(new Error("connect failed for key gb_secret_key"));
    const client = createGbrainClient(connection, fetchImpl);
    const result = await client.recall({ companyId: "co_1", query: "x" });
    expect(result.status).toBe("error");
    expect(result.detail ?? "").not.toContain("gb_secret_key");
  });

  it("returns an error status on a non-2xx response", async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse(500, { error: "boom" }));
    const client = createGbrainClient(connection, fetchImpl);
    const result = await client.ingest({ companyId: "co_1", runId: "amr_1", title: "t", content: "c", source: "s" });
    expect(result.status).toBe("error");
  });
});
