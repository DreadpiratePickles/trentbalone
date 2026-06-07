import { describe, expect, it, vi } from "vitest";
import { createGoogleSendAdapter } from "@/lib/google/google-send-adapter";
import type { GoogleClient } from "@/lib/google/google-client";

function fakeClient(overrides: Partial<GoogleClient> = {}): GoogleClient {
  return {
    connected: true,
    listRecentEmails: vi.fn(),
    listUpcomingEvents: vi.fn(),
    sendEmail: vi.fn(async () => ({ messageId: "sent_1" })),
    createEvent: vi.fn(async () => ({ eventId: "ev_1" })),
    ...overrides,
  };
}

const BASE = { companyId: "operator", runId: "run_1" };

describe("createGoogleSendAdapter", () => {
  it("drafts an email without touching Google", async () => {
    const client = fakeClient();
    const adapter = createGoogleSendAdapter(client);
    const result = await adapter.draftEmail({ ...BASE, to: "lead@acme.com", subject: "Hi", body: "Hello" });
    expect(result.status).toBe("draft");
    expect(client.sendEmail).not.toHaveBeenCalled();
  });

  it("requires approval before sending an email", async () => {
    const client = fakeClient();
    const adapter = createGoogleSendAdapter(client);
    const result = await adapter.sendApprovedEmail({ ...BASE, to: "lead@acme.com", subject: "Hi", body: "Hello" });
    expect(result.status).toBe("needs_approval");
    expect(result.gate).toBe("email_or_sales_send");
    expect(client.sendEmail).not.toHaveBeenCalled();
  });

  it("sends the email once an approval id is present", async () => {
    const client = fakeClient();
    const adapter = createGoogleSendAdapter(client);
    const result = await adapter.sendApprovedEmail({ ...BASE, to: "lead@acme.com", subject: "Hi", body: "Hello", approvalId: "appr_1" });
    expect(result.status).toBe("executed");
    expect(result.externalRef).toBe("sent_1");
    expect(result.event?.kind).toBe("artifact_created");
    expect(client.sendEmail).toHaveBeenCalledWith({ to: "lead@acme.com", subject: "Hi", body: "Hello" });
  });

  it("requires approval before scheduling a calendar event", async () => {
    const client = fakeClient();
    const adapter = createGoogleSendAdapter(client);
    const result = await adapter.scheduleApprovedEvent({ ...BASE, summary: "Demo", start: "2026-06-06T17:00:00Z", end: "2026-06-06T17:30:00Z", attendees: ["p@acme.com"] });
    expect(result.status).toBe("needs_approval");
    expect(result.gate).toBe("email_or_sales_send");
    expect(client.createEvent).not.toHaveBeenCalled();
  });

  it("schedules the event once approved", async () => {
    const client = fakeClient();
    const adapter = createGoogleSendAdapter(client);
    const result = await adapter.scheduleApprovedEvent({ ...BASE, summary: "Demo", start: "2026-06-06T17:00:00Z", end: "2026-06-06T17:30:00Z", attendees: ["p@acme.com"], approvalId: "appr_2" });
    expect(result.status).toBe("executed");
    expect(result.externalRef).toBe("ev_1");
    expect(client.createEvent).toHaveBeenCalledOnce();
  });

  it("reports needs_credentials when Google is not connected", async () => {
    const client = fakeClient({ connected: false });
    const adapter = createGoogleSendAdapter(client);
    const result = await adapter.sendApprovedEmail({ ...BASE, to: "x@y.com", subject: "Hi", body: "Hello", approvalId: "appr_1" });
    expect(result.status).toBe("needs_credentials");
    expect(client.sendEmail).not.toHaveBeenCalled();
  });
});
