import { describe, expect, it } from "vitest";
import { assertCanSpamCompliant, assertGdprCompliant } from "./compliance";
import { assertOutboundRateAllowed } from "./rate-limits";
import { buildSuppressionIndex, isSuppressed } from "./suppression";

describe("outbound compliance, suppression, and rate limits", () => {
  it("enforces CAN-SPAM footer, opt-out link, sender identity, and 10-day honoring", () => {
    expect(() => assertCanSpamCompliant({
      body: "Hello\n\n123 Sender St\nUnsubscribe: https://x.test/u",
      senderName: "Trent",
      unsubscribeRequestedAt: "2026-05-01T00:00:00.000Z",
      now: "2026-05-12T00:00:00.000Z",
    })).toThrow("suppressed by CAN-SPAM opt-out window");
  });

  it("requires GDPR lawful basis and regional suppression checks", () => {
    expect(() => assertGdprCompliant({
      region: "EU",
      lawfulBasis: undefined,
      consentRecordedAt: undefined,
      regionSuppressed: false,
    })).toThrow("lawful basis");
  });

  it("blocks suppressed recipients and per-recipient/domain/sender rate excess", () => {
    const index = buildSuppressionIndex([
      { value: "person@example.com", reason: "complaint", createdAt: "2026-05-29T00:00:00.000Z" },
    ]);
    expect(isSuppressed(index, "person@example.com")?.reason).toBe("complaint");
    expect(() => assertOutboundRateAllowed({
      recipientCount24h: 3,
      domainCount24h: 20,
      senderCount24h: 100,
      limits: { recipientPerDay: 3, domainPerDay: 50, senderPerDay: 200 },
    })).toThrow("recipient");
  });
});
