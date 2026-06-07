import { describe, expect, it, vi } from "vitest";
import { ingestGoogleContext } from "@/lib/google/google-memory";
import type { GoogleClient } from "@/lib/google/google-client";
import type { GbrainClient } from "@/lib/gbrain/gbrain-client";
import { store } from "@/lib/store";
import { makeId } from "@/lib/utils";

function fakeGoogleClient(overrides: Partial<GoogleClient> = {}): GoogleClient {
  return {
    connected: true,
    listRecentEmails: vi.fn(async () => [
      { id: "m1", from: "cfo@acme.com", subject: "Q3 results", date: "2026-06-03", snippet: "numbers attached" },
    ]),
    listUpcomingEvents: vi.fn(async () => [
      { id: "ev1", summary: "Board sync", start: "2026-06-05T15:00:00Z", end: "2026-06-05T16:00:00Z", attendees: ["chair@board.com"] },
    ]),
    sendEmail: vi.fn(),
    createEvent: vi.fn(),
    ...overrides,
  };
}

function fakeGbrain(captured: { input?: unknown }): GbrainClient {
  return {
    connected: true,
    ingest: vi.fn(async (input) => { captured.input = input; return { status: "ingested" as const, source: "sidecar" as const, documentId: "gb_1" }; }),
    recall: vi.fn(),
    advise: vi.fn(),
  };
}

describe("ingestGoogleContext", () => {
  it("skips when Google is not connected", async () => {
    const result = await ingestGoogleContext(
      { scopeId: makeId("operator") },
      { client: fakeGoogleClient({ connected: false }), gbrain: fakeGbrain({}) },
    );
    expect(result.status).toBe("skipped");
    expect(result.emailCount).toBe(0);
    expect(result.eventCount).toBe(0);
  });

  it("persists a local memory document and pushes context to the sidecar", async () => {
    const scopeId = makeId("operator");
    const captured: { input?: unknown } = {};
    const result = await ingestGoogleContext(
      { scopeId },
      { client: fakeGoogleClient(), gbrain: fakeGbrain(captured) },
    );

    expect(result.status).toBe("ingested");
    expect(result.emailCount).toBe(1);
    expect(result.eventCount).toBe(1);
    expect(result.documentId).toBeTruthy();

    const docs = await store.listDocuments(scopeId);
    const doc = docs.find((d) => d.id === result.documentId);
    expect(doc?.companyId).toBe(scopeId);
    expect(doc?.content).toContain("Q3 results");
    expect(doc?.content).toContain("Board sync");

    const ingested = captured.input as { content: string; tags: string[] };
    expect(ingested.content).toContain("Q3 results");
    expect(ingested.tags).toContain("google");
  });
});
