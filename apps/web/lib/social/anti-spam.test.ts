import { describe, expect, it } from "vitest";
import {
  assertDirectMessageAllowed,
  nextContactStateAfterMessage,
  normalizeOptOutStatus,
} from "./anti-spam";
import type { SocialContact } from "./types";

describe("social/anti-spam", () => {
  it("blocks outbound DMs for opted-out contacts", () => {
    const contact = contactFixture({
      optOutStatus: "opted_out",
      engagementState: "engaged",
    });

    expect(() => assertDirectMessageAllowed(contact)).toThrow("Contact has opted out");
  });

  it("prevents double-DM outreach when the contact has not engaged", () => {
    const contact = contactFixture({
      engagementState: "contacted",
      lastOutboundAt: "2026-05-29T10:00:00.000Z",
      lastInboundAt: undefined,
    });

    expect(() => assertDirectMessageAllowed(contact)).toThrow("Cannot send another DM before engagement");
  });

  it("allows a follow-up after inbound engagement and transitions state to engaged", () => {
    const contact = contactFixture({
      engagementState: "contacted",
      lastOutboundAt: "2026-05-29T10:00:00.000Z",
      lastInboundAt: "2026-05-29T10:05:00.000Z",
    });

    expect(() => assertDirectMessageAllowed(contact)).not.toThrow();
    expect(nextContactStateAfterMessage(contact, "inbound")).toEqual({
      engagementState: "engaged",
      lastInboundAt: expect.any(String),
    });
  });

  it("normalizes opt-out commands from contact messages", () => {
    expect(normalizeOptOutStatus("please STOP messaging me")).toBe("opted_out");
    expect(normalizeOptOutStatus("sounds good, send details")).toBe("not_opted_out");
  });
});

function contactFixture(overrides: Partial<SocialContact>): SocialContact {
  return {
    id: "soccontact_1",
    companyId: "co_1",
    platform: "instagram",
    externalContactId: "ig_user_1",
    handle: "@founder",
    displayName: "Founder",
    profileUrl: undefined,
    engagementState: "unknown",
    optOutStatus: "not_opted_out",
    lastOutboundAt: undefined,
    lastInboundAt: undefined,
    memory: {},
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:00.000Z",
    ...overrides,
  };
}
