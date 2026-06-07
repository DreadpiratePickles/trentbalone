import { describe, expect, it } from "vitest";
import {
  assertServerEventConsent,
  makeConversionEventId,
  normalizeEventName,
} from "./events";
import type { MarketingAccount } from "./types";

describe("marketing event helpers", () => {
  it("accepts only the supported conversion event taxonomy", () => {
    expect([
      "PageView",
      "ViewContent",
      "Lead",
      "StartTrial",
      "Subscribe",
      "Purchase",
      "QualifiedLead",
    ].map(normalizeEventName)).toEqual([
      "PageView",
      "ViewContent",
      "Lead",
      "StartTrial",
      "Subscribe",
      "Purchase",
      "QualifiedLead",
    ]);

    expect(() => normalizeEventName("Signup")).toThrow(/Unsupported marketing event/i);
    expect(() => normalizeEventName("lead")).toThrow(/Unsupported marketing event/i);
  });

  it("builds stable conversion event ids from canonical inputs", () => {
    const occurredAt = "2026-05-29T10:15:00.000Z";
    const first = makeConversionEventId("co_1", "Lead", occurredAt, "external_1");
    const second = makeConversionEventId("co_1", "Lead", occurredAt, "external_1");

    expect(first).toBe(second);
    expect(first).toMatch(/^evt_[a-f0-9]{32}$/);
    expect(makeConversionEventId("co_1", "Lead", occurredAt, "external_2")).not.toBe(first);
  });

  it("requires account consent before sending server conversion events", () => {
    const account = {
      id: "mktacct_1",
      companyId: "co_1",
      platform: "meta",
      status: "active",
      externalAccountId: "act_123",
      currency: "USD",
      paymentStatus: "ready",
      consentForServerEvents: false,
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:00.000Z",
    } satisfies MarketingAccount;

    expect(() => assertServerEventConsent(account)).toThrow(/Server event consent/i);
    expect(assertServerEventConsent({ ...account, consentForServerEvents: true })).toBeUndefined();
  });
});
