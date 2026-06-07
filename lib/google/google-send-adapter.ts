import type { GoogleClient } from "@/lib/google/google-client";
import type { MissionActionResult, MissionArtifact } from "@/lib/content/mission-adapters";

// Outbound Google actions (send email, schedule meeting) for the operator's
// agents. Every send is gated on `email_or_sales_send`: without an approval id
// the adapter returns the gate and touches nothing; with one it carries out the
// already-approved send. GBrain advises; Trent's approval gate decides; this
// adapter only executes what was approved.

const GMAIL_GATE = "email_or_sales_send" as const;

type GoogleSendBase = { companyId: string; runId: string };

export type GoogleSendAdapter = {
  draftEmail(input: GoogleSendBase & { to: string; subject: string; body: string }): Promise<MissionActionResult>;
  sendApprovedEmail(
    input: GoogleSendBase & { to: string; subject: string; body: string; approvalId?: string },
  ): Promise<MissionActionResult>;
  scheduleApprovedEvent(
    input: GoogleSendBase & { summary: string; start: string; end: string; attendees?: string[]; approvalId?: string },
  ): Promise<MissionActionResult>;
};

export function createGoogleSendAdapter(client: GoogleClient): GoogleSendAdapter {
  function notConnected(): MissionActionResult {
    return { status: "needs_credentials", detail: "Google is not connected for the operator." };
  }

  return {
    async draftEmail({ to, subject, body }) {
      return {
        status: "draft",
        artifact: {
          kind: "email_draft",
          title: `Email draft to ${to}: ${subject}`,
          content: body,
          createdByAgent: "sales",
        },
      };
    },

    async sendApprovedEmail({ to, subject, body, approvalId }) {
      if (!client.connected) return notConnected();
      if (!approvalId) return { status: "needs_approval", gate: GMAIL_GATE };
      const { messageId } = await client.sendEmail({ to, subject, body });
      const artifact: MissionArtifact = {
        kind: "email_sent",
        title: `Email sent to ${to}: ${subject}`,
        content: body,
        createdByAgent: "sales",
      };
      return {
        status: "executed",
        externalRef: messageId,
        artifact,
        event: { kind: "artifact_created", payload: { artifactKind: artifact.kind, externalRef: messageId, approvalId } },
      };
    },

    async scheduleApprovedEvent({ summary, start, end, attendees, approvalId }) {
      if (!client.connected) return notConnected();
      if (!approvalId) return { status: "needs_approval", gate: GMAIL_GATE };
      const { eventId } = await client.createEvent({ summary, start, end, attendees });
      const artifact: MissionArtifact = {
        kind: "calendar_event",
        title: `Calendar event scheduled: ${summary}`,
        content: `${start} → ${end}${attendees?.length ? ` with ${attendees.join(", ")}` : ""}`,
        createdByAgent: "sales",
      };
      return {
        status: "executed",
        externalRef: eventId,
        artifact,
        event: { kind: "artifact_created", payload: { artifactKind: artifact.kind, externalRef: eventId, approvalId } },
      };
    },
  };
}
