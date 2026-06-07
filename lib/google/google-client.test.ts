import { describe, expect, it, vi } from "vitest";
import { createGoogleClient } from "@/lib/google/google-client";
import type { GoogleConnection } from "@/lib/google/google-connection";
import type { GoogleFetch } from "@/lib/google/google-client";

const CONNECTION: GoogleConnection = {
  source: "operator",
  refreshToken: "rt_value",
  clientId: "client_123",
  clientSecret: "secret_xyz",
  scopes: ["gmail.readonly", "gmail.send", "calendar.events"],
};

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// Routes mock responses by URL substring. Records every call for assertions.
function mockFetch(routes: Array<{ match: string; respond: (init: { method: string; body?: string }) => ReturnType<typeof jsonResponse> }>) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
  const fetchImpl: GoogleFetch = vi.fn(async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const route = routes.find((r) => url.includes(r.match));
    if (!route) throw new Error(`no mock route for ${url}`);
    return route.respond({ method: init.method, body: init.body });
  });
  return { fetchImpl, calls };
}

describe("createGoogleClient", () => {
  it("is not connected without refresh token + app credentials", () => {
    const client = createGoogleClient({ source: "missing" });
    expect(client.connected).toBe(false);
  });

  it("refreshes the access token then lists recent emails", async () => {
    const { fetchImpl, calls } = mockFetch([
      { match: "oauth2.googleapis.com/token", respond: () => jsonResponse(200, { access_token: "at_fresh", expires_in: 3600 }) },
      { match: "messages?", respond: () => jsonResponse(200, { messages: [{ id: "m1" }] }) },
      {
        match: "messages/m1",
        respond: () => jsonResponse(200, {
          id: "m1",
          snippet: "Quarterly numbers attached",
          payload: { headers: [{ name: "From", value: "cfo@acme.com" }, { name: "Subject", value: "Q3 results" }, { name: "Date", value: "Tue, 3 Jun 2026 10:00:00 +0000" }] },
        }),
      },
    ]);
    const client = createGoogleClient(CONNECTION, fetchImpl);
    const emails = await client.listRecentEmails(5);

    expect(calls[0].url).toContain("oauth2.googleapis.com/token");
    expect(calls[0].body).toContain("grant_type=refresh_token");
    expect(calls[1].headers.Authorization).toBe("Bearer at_fresh");
    expect(emails).toEqual([
      { id: "m1", from: "cfo@acme.com", subject: "Q3 results", date: "Tue, 3 Jun 2026 10:00:00 +0000", snippet: "Quarterly numbers attached" },
    ]);
  });

  it("lists upcoming calendar events", async () => {
    const { fetchImpl } = mockFetch([
      { match: "oauth2.googleapis.com/token", respond: () => jsonResponse(200, { access_token: "at", expires_in: 3600 }) },
      {
        match: "calendar/v3",
        respond: () => jsonResponse(200, {
          items: [{ id: "ev1", summary: "Board sync", start: { dateTime: "2026-06-05T15:00:00Z" }, end: { dateTime: "2026-06-05T16:00:00Z" }, attendees: [{ email: "chair@board.com" }] }],
        }),
      },
    ]);
    const client = createGoogleClient(CONNECTION, fetchImpl);
    const events = await client.listUpcomingEvents(5);
    expect(events).toEqual([
      { id: "ev1", summary: "Board sync", start: "2026-06-05T15:00:00Z", end: "2026-06-05T16:00:00Z", attendees: ["chair@board.com"] },
    ]);
  });

  it("sends an email as base64url raw MIME and returns the message id", async () => {
    let sentBody = "";
    const { fetchImpl } = mockFetch([
      { match: "oauth2.googleapis.com/token", respond: () => jsonResponse(200, { access_token: "at", expires_in: 3600 }) },
      { match: "messages/send", respond: (init) => { sentBody = init.body ?? ""; return jsonResponse(200, { id: "sent_1" }); } },
    ]);
    const client = createGoogleClient(CONNECTION, fetchImpl);
    const result = await client.sendEmail({ to: "lead@acme.com", subject: "Following up", body: "Great talking today." });

    expect(result).toEqual({ messageId: "sent_1" });
    const raw = JSON.parse(sentBody).raw as string;
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    expect(decoded).toContain("To: lead@acme.com");
    expect(decoded).toContain("Subject: Following up");
    expect(decoded).toContain("Great talking today.");
  });

  it("creates a calendar event and returns the event id", async () => {
    const { fetchImpl } = mockFetch([
      { match: "oauth2.googleapis.com/token", respond: () => jsonResponse(200, { access_token: "at", expires_in: 3600 }) },
      { match: "calendar/v3", respond: () => jsonResponse(200, { id: "ev_new" }) },
    ]);
    const client = createGoogleClient(CONNECTION, fetchImpl);
    const result = await client.createEvent({ summary: "Demo call", start: "2026-06-06T17:00:00Z", end: "2026-06-06T17:30:00Z", attendees: ["prospect@acme.com"] });
    expect(result).toEqual({ eventId: "ev_new" });
  });

  it("redacts secrets from error details", async () => {
    const fetchImpl: GoogleFetch = vi.fn(async () => { throw new Error("token rt_value leaked and secret_xyz too"); });
    const client = createGoogleClient(CONNECTION, fetchImpl);
    await expect(client.listRecentEmails(1)).rejects.toThrow(/\[REDACTED\]/);
  });
});
