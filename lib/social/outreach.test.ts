import { describe, expect, it, vi } from "vitest";
import { assertOutreachAllowed, createPersonalizedOutreachDraft, type SocialOutreachContact } from "./outreach";

describe("social outreach", () => {
  it("creates a personalized draft and pending approval without sending", async () => {
    const createSocialOutreachDraft = vi.fn(async (input) => ({
      ...input,
      id: "draft_1",
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:00.000Z",
    }));
    const updateSocialOutreachDraft = vi.fn(async (id, patch) => ({
      id,
      companyId: "co_1",
      contactId: "contact_1",
      platform: "linkedin" as const,
      purpose: "ugc_collaboration",
      message: "Hi Maya",
      status: "pending_approval" as const,
      riskFlags: [] as string[],
      approvalId: patch.approvalId,
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:00.000Z",
    }));
    const createApproval = vi.fn(async (input) => ({
      ...input,
      id: "approval_1",
      status: "pending",
      createdAt: "2026-05-29T00:00:00.000Z",
    }));
    const sendDm = vi.fn();

    const result = await createPersonalizedOutreachDraft({
      store: { createSocialOutreachDraft, updateSocialOutreachDraft, createApproval },
      companyId: "co_1",
      contact: contact({
        displayName: "Maya Chen",
        handle: "@maya",
        memory: { interests: ["founder workflows"], lastPositiveSignal: "shared Trent launch post" },
      }),
      purpose: "ugc_collaboration",
      context: "Invite them to record a short operator workflow clip.",
      senderName: "Bobby",
    });

    expect(createSocialOutreachDraft).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "co_1",
      contactId: "contact_1",
      platform: "linkedin",
      purpose: "ugc_collaboration",
      status: "draft",
    }));
    expect(createSocialOutreachDraft.mock.calls[0]?.[0].message).toContain("Maya Chen");
    expect(createSocialOutreachDraft.mock.calls[0]?.[0].message).toContain("founder workflows");
    expect(createApproval).toHaveBeenCalledWith(expect.objectContaining({
      action: "send_social_outreach",
      previewKind: "generic",
    }));
    expect(updateSocialOutreachDraft).toHaveBeenCalledWith("draft_1", expect.objectContaining({
      approvalId: "approval_1",
      status: "pending_approval",
    }));
    expect(sendDm).not.toHaveBeenCalled();
    expect(result.approval.status).toBe("pending");
  });

  it("enforces opt-out and no double-DM without engagement", async () => {
    await expect(assertOutreachAllowed(contact({ optOutStatus: "opted_out" })))
      .rejects.toThrow("opted out");

    await expect(assertOutreachAllowed(contact({
      engagementState: "unknown",
      lastOutboundAt: "2026-05-28T00:00:00.000Z",
      lastInboundAt: undefined,
    }))).rejects.toThrow("No double-DM");

    await expect(assertOutreachAllowed(contact({
      engagementState: "engaged",
      lastOutboundAt: "2026-05-28T00:00:00.000Z",
      lastInboundAt: "2026-05-28T12:00:00.000Z",
    }))).resolves.toEqual([]);
  });
});

function contact(overrides: Partial<SocialOutreachContact> = {}): SocialOutreachContact {
  return {
    id: "contact_1",
    companyId: "co_1",
    platform: "linkedin",
    externalContactId: "external_contact_1",
    handle: "@maya",
    displayName: "Maya",
    profileUrl: "https://linkedin.example/maya",
    engagementState: "engaged",
    optOutStatus: "not_opted_out",
    lastOutboundAt: undefined,
    lastInboundAt: "2026-05-28T12:00:00.000Z",
    memory: {},
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:00.000Z",
    ...overrides,
  };
}
