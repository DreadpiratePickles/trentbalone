import { describe, expect, it } from "vitest";
import { createCrmSyncPlan } from "./crm-sync";
import { mergeEnrichment } from "./enrichment";
import { buildUnifiedThreadKey, summarizeUnifiedThread } from "./inbox";
import { buildPersonalizationBrief } from "./personalization";

describe("inbox, personalization, enrichment, and CRM sync", () => {
  it("uses one thread per contact across email, SMS, WhatsApp, and voice", () => {
    const key = buildUnifiedThreadKey({ companyId: "co_1", contactId: "lead_1" });
    const summary = summarizeUnifiedThread([
      { channel: "email", contactId: "lead_1", body: "Can we talk?", at: "2026-05-29T10:00:00.000Z" },
      { channel: "sms", contactId: "lead_1", body: "Yes tomorrow", at: "2026-05-29T10:05:00.000Z" },
      { channel: "voice", contactId: "lead_1", body: "Call transcript: booked demo", at: "2026-05-29T10:10:00.000Z" },
    ]);
    expect(key).toBe("co_1:lead_1");
    expect(summary.channels).toEqual(["email", "sms", "voice"]);
    expect(summary.latestBody).toContain("booked demo");
  });

  it("builds per-recipient research briefs before send", () => {
    const brief = buildPersonalizationBrief({
      name: "Casey",
      company: "Acme",
      role: "Head of Growth",
      signals: ["hiring SDRs", "launched a new product"],
      painPoints: ["pipeline quality"],
    });
    expect(brief.openingLine).toContain("Casey");
    expect(brief.talkingPoints).toContain("hiring SDRs");
  });

  it("merges enrichment without overwriting verified CRM data", () => {
    const merged = mergeEnrichment({
      existing: { email: "casey@acme.test", title: "VP Growth", source: "crm" },
      enriched: { title: "Head of Growth", linkedinUrl: "https://linkedin.test/casey", source: "apollo" },
    });
    expect(merged.title).toBe("VP Growth");
    expect(merged.linkedinUrl).toContain("linkedin");
  });

  it("plans bidirectional CRM sync for HubSpot, Salesforce, Pipedrive, Attio, and Close", () => {
    const plan = createCrmSyncPlan({
      provider: "salesforce",
      localUpdatedAt: "2026-05-29T12:00:00.000Z",
      remoteUpdatedAt: "2026-05-29T11:00:00.000Z",
      changedFields: ["stage"],
    });
    expect(plan.direction).toBe("push_to_crm");
    expect(plan.supportedProviders).toContain("hubspot");
    expect(plan.supportedProviders).toContain("close");
  });
});
