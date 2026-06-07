import type { GoogleConnection } from "@/lib/google/google-connection";

// Thin Google API client for Gmail + Calendar. Injectable fetch so it is fully
// testable without real network. It reads (mail/events) for memory ingest and
// can send/schedule — but callers route sends through Trent's approval gates.
// GBrain advises; Trent decides; this client only carries out an already
// approved action.

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3/calendars/primary";

export type GoogleHttpResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

export type GoogleFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<GoogleHttpResponse>;

export type GoogleEmail = { id: string; from: string; subject: string; date: string; snippet: string };
export type GoogleEvent = { id: string; summary: string; start: string; end: string; attendees: string[] };
export type SendEmailInput = { to: string; subject: string; body: string };
export type CreateEventInput = { summary: string; start: string; end: string; attendees?: string[] };

export type GoogleClient = {
  connected: boolean;
  listRecentEmails(limit?: number): Promise<GoogleEmail[]>;
  listUpcomingEvents(limit?: number): Promise<GoogleEvent[]>;
  sendEmail(input: SendEmailInput): Promise<{ messageId: string }>;
  createEvent(input: CreateEventInput): Promise<{ eventId: string }>;
};

export function createGoogleClient(connection: GoogleConnection, fetchImpl?: GoogleFetch): GoogleClient {
  const doFetch = fetchImpl ?? defaultFetch;
  const canRefresh = Boolean(connection.refreshToken && connection.clientId && connection.clientSecret);
  const connected = canRefresh || Boolean(connection.accessToken);

  let accessToken = connection.accessToken;
  let expiresAt = connection.expiresAt ? Date.parse(connection.expiresAt) : 0;

  async function token(): Promise<string> {
    if (accessToken && expiresAt > Date.now() + 30_000) return accessToken;
    if (!canRefresh) {
      if (accessToken) return accessToken;
      throw new Error("Google is not connected");
    }
    const params = new URLSearchParams({
      client_id: connection.clientId!,
      client_secret: connection.clientSecret!,
      refresh_token: connection.refreshToken!,
      grant_type: "refresh_token",
    });
    const response = await doFetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    if (!response.ok) throw new Error(`Google token refresh failed (${response.status})`);
    const data = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) throw new Error("Google token refresh returned no access_token");
    accessToken = data.access_token;
    expiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
    return accessToken;
  }

  async function authed(url: string, init: { method: string; body?: string; contentType?: string }): Promise<unknown> {
    const headers: Record<string, string> = { Authorization: `Bearer ${await token()}` };
    if (init.body !== undefined) headers["Content-Type"] = init.contentType ?? "application/json";
    const response = await doFetch(url, { method: init.method, headers, body: init.body });
    if (!response.ok) throw new Error(`Google API request failed (${response.status})`);
    return response.json().catch(() => ({}));
  }

  function guard(): void {
    if (!connected) throw new Error("Google is not connected");
  }

  return {
    connected,

    async listRecentEmails(limit = 10) {
      guard();
      try {
        const list = (await authed(`${GMAIL_BASE}/messages?maxResults=${limit}`, { method: "GET" })) as { messages?: Array<{ id: string }> };
        const ids = (list.messages ?? []).map((m) => m.id);
        const emails: GoogleEmail[] = [];
        for (const id of ids) {
          const msg = (await authed(`${GMAIL_BASE}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, { method: "GET" })) as {
            id: string;
            snippet?: string;
            payload?: { headers?: Array<{ name: string; value: string }> };
          };
          const headers = msg.payload?.headers ?? [];
          emails.push({
            id: msg.id,
            from: header(headers, "From"),
            subject: header(headers, "Subject"),
            date: header(headers, "Date"),
            snippet: msg.snippet ?? "",
          });
        }
        return emails;
      } catch (error) {
        throw redacted(error, connection);
      }
    },

    async listUpcomingEvents(limit = 10) {
      guard();
      try {
        const timeMin = new Date().toISOString();
        const url = `${CALENDAR_BASE}/events?maxResults=${limit}&singleEvents=true&orderBy=startTime&timeMin=${encodeURIComponent(timeMin)}`;
        const data = (await authed(url, { method: "GET" })) as { items?: Array<{ id: string; summary?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string }; attendees?: Array<{ email: string }> }> };
        return (data.items ?? []).map((item) => ({
          id: item.id,
          summary: item.summary ?? "",
          start: item.start?.dateTime ?? item.start?.date ?? "",
          end: item.end?.dateTime ?? item.end?.date ?? "",
          attendees: (item.attendees ?? []).map((a) => a.email),
        }));
      } catch (error) {
        throw redacted(error, connection);
      }
    },

    async sendEmail(input) {
      guard();
      try {
        const mime = [
          `To: ${input.to}`,
          `Subject: ${input.subject}`,
          "Content-Type: text/plain; charset=utf-8",
          "",
          input.body,
        ].join("\r\n");
        const raw = Buffer.from(mime, "utf8").toString("base64url");
        const data = (await authed(`${GMAIL_BASE}/messages/send`, { method: "POST", body: JSON.stringify({ raw }) })) as { id?: string };
        return { messageId: data.id ?? "" };
      } catch (error) {
        throw redacted(error, connection);
      }
    },

    async createEvent(input) {
      guard();
      try {
        const payload = {
          summary: input.summary,
          start: { dateTime: input.start },
          end: { dateTime: input.end },
          attendees: (input.attendees ?? []).map((email) => ({ email })),
        };
        const data = (await authed(`${CALENDAR_BASE}/events`, { method: "POST", body: JSON.stringify(payload) })) as { id?: string };
        return { eventId: data.id ?? "" };
      } catch (error) {
        throw redacted(error, connection);
      }
    },
  };
}

const defaultFetch: GoogleFetch = async (url, init) => {
  const response = await fetch(url, init);
  return { ok: response.ok, status: response.status, json: () => response.json() };
};

function header(headers: Array<{ name: string; value: string }>, name: string): string {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function redacted(error: unknown, connection: GoogleConnection): Error {
  let message = error instanceof Error ? error.message : "Google request failed.";
  for (const secret of [connection.refreshToken, connection.accessToken, connection.clientSecret]) {
    if (secret && secret.length >= 4) message = message.split(secret).join("[REDACTED]");
  }
  return new Error(message);
}
