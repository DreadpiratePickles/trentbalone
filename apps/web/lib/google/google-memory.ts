import { createGoogleClient, type GoogleClient, type GoogleEmail, type GoogleEvent } from "@/lib/google/google-client";
import { OPERATOR_SCOPE, resolveGoogleConnection } from "@/lib/google/google-connection";
import { createGbrainClient, resolveGbrainConnection, type GbrainClient } from "@/lib/gbrain/gbrain-client";
import { store } from "@/lib/store";
import { nowIso } from "@/lib/utils";

// Pull the operator's recent Gmail + Calendar into memory. Reads only — this
// feeds GBrain so agents can recall the operator's real context. It persists a
// local memory Document (so recall works even with no sidecar) and also pushes
// to the GBrain sidecar when one is connected.

export type GoogleMemoryDeps = { client?: GoogleClient; gbrain?: GbrainClient };

export type IngestGoogleContextOptions = {
  scopeId?: string;
  emailLimit?: number;
  eventLimit?: number;
};

export type GoogleContextResult = {
  status: "ingested" | "skipped" | "error";
  documentId?: string;
  emailCount: number;
  eventCount: number;
  sidecar?: "ingested" | "not_connected" | "error";
  reason?: string;
};

export async function ingestGoogleContext(
  options: IngestGoogleContextOptions = {},
  deps: GoogleMemoryDeps = {},
): Promise<GoogleContextResult> {
  const scopeId = options.scopeId ?? OPERATOR_SCOPE;
  const client = deps.client ?? createGoogleClient(await resolveGoogleConnection(scopeId));
  if (!client.connected) {
    return { status: "skipped", emailCount: 0, eventCount: 0, reason: "Google is not connected." };
  }

  const emails = await client.listRecentEmails(options.emailLimit ?? 10);
  const events = await client.listUpcomingEvents(options.eventLimit ?? 10);
  const generatedAt = nowIso();
  const title = `Operator Google context: ${generatedAt.slice(0, 10)}`;
  const source = `operator-google:${generatedAt}`;
  const content = buildGoogleContextMarkdown({ emails, events, generatedAt });

  const document = await store.createDocument({
    companyId: scopeId,
    type: "agent_note",
    title,
    content,
    source,
    memoryTier: "episodic",
  });

  const gbrain = deps.gbrain ?? createGbrainClient(await resolveGbrainConnection(scopeId));
  const ingest = await gbrain.ingest({
    companyId: scopeId,
    runId: document.id,
    title,
    content,
    source,
    tags: ["operator", "google", "inbox", "calendar"],
  });

  return {
    status: "ingested",
    documentId: document.id,
    emailCount: emails.length,
    eventCount: events.length,
    sidecar: ingest.status === "ingested" ? "ingested" : ingest.status === "not_connected" ? "not_connected" : "error",
  };
}

export function buildGoogleContextMarkdown(input: { emails: GoogleEmail[]; events: GoogleEvent[]; generatedAt: string }): string {
  const { emails, events, generatedAt } = input;
  return [
    "# Operator Google Context",
    "",
    "## Recent Email",
    emails.length
      ? emails.map((e) => `- ${e.date} — **${e.subject || "(no subject)"}** from ${e.from}: ${e.snippet}`).join("\n")
      : "No recent email.",
    "",
    "## Upcoming Calendar",
    events.length
      ? events.map((ev) => `- ${ev.start} → ${ev.end} — **${ev.summary || "(no title)"}**${ev.attendees.length ? ` with ${ev.attendees.join(", ")}` : ""}`).join("\n")
      : "No upcoming events.",
    "",
    `Generated: ${generatedAt}`,
  ].join("\n");
}
