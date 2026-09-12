import { beforeEach, describe, expect, it } from "vitest";
import { memStore } from "@/lib/mem-store";
import { listUnifiedInbox, updateSocialContactMemory } from "./inbox";

describe("social/inbox", () => {
  beforeEach(() => {
    globalThis.__trentState = undefined;
  });

  it("lists conversations across accounts with contact and latest message context", async () => {
    const account = await memStore.upsertSocialAccount({
      companyId: "co_1",
      platform: "instagram",
      externalAccountId: "ig_acct",
      externalHandle: "@trent",
      scopes: ["inbox:read"],
    });
    const contact = await memStore.upsertSocialContact({
      companyId: "co_1",
      platform: "instagram",
      externalContactId: "ig_user_1",
      handle: "@founder",
      displayName: "Founder",
      memory: { interests: ["pricing"] },
    });
    const older = await memStore.upsertSocialConversation({
      companyId: "co_1",
      socialAccountId: account.id,
      platform: "instagram",
      externalThreadId: "thread_old",
      contactId: contact.id,
      lastMessageAt: "2026-05-29T10:00:00.000Z",
      metadata: {},
    });
    const newer = await memStore.upsertSocialConversation({
      companyId: "co_1",
      socialAccountId: account.id,
      platform: "instagram",
      externalThreadId: "thread_new",
      contactId: contact.id,
      lastMessageAt: "2026-05-29T11:00:00.000Z",
      metadata: {},
    });
    await memStore.createSocialMessage({
      companyId: "co_1",
      conversationId: older.id,
      contactId: contact.id,
      direction: "inbound",
      kind: "dm",
      content: "Earlier question",
      externalMessageId: "msg_old",
      sentAt: "2026-05-29T10:00:00.000Z",
      metadata: {},
    });
    await memStore.createSocialMessage({
      companyId: "co_1",
      conversationId: newer.id,
      contactId: contact.id,
      direction: "inbound",
      kind: "dm",
      content: "Can you send pricing?",
      externalMessageId: "msg_new",
      sentAt: "2026-05-29T11:00:00.000Z",
      metadata: {},
    });

    const inbox = await listUnifiedInbox(memStore, "co_1");

    expect(inbox).toHaveLength(2);
    expect(inbox[0]).toMatchObject({
      conversation: { id: newer.id, platform: "instagram" },
      contact: { id: contact.id, handle: "@founder" },
      latestMessage: { content: "Can you send pricing?", direction: "inbound" },
    });
    expect(inbox[1].conversation.id).toBe(older.id);
  });

  it("merges per-contact memory and can advance engagement state", async () => {
    const contact = await memStore.upsertSocialContact({
      companyId: "co_1",
      platform: "linkedin",
      externalContactId: "li_user_1",
      handle: "founder",
      engagementState: "contacted",
      memory: { interests: ["social launch"], notes: "Asked about pricing" },
    });

    const updated = await updateSocialContactMemory(memStore, {
      companyId: "co_1",
      contactId: contact.id,
      memory: { interests: ["social launch", "demo"], lastIntent: "book_call" },
      engagementState: "engaged",
    });

    expect(updated.memory).toEqual({
      interests: ["social launch", "demo"],
      notes: "Asked about pricing",
      lastIntent: "book_call",
    });
    expect(updated.engagementState).toBe("engaged");
  });

  it("enforces opt-out and no double-DM when recording outbound messages", async () => {
    const account = await memStore.upsertSocialAccount({
      companyId: "co_1",
      platform: "instagram",
      externalAccountId: "ig_acct",
      scopes: ["dm:write"],
    });
    const contact = await memStore.upsertSocialContact({
      companyId: "co_1",
      platform: "instagram",
      externalContactId: "ig_user_2",
      engagementState: "contacted",
      lastOutboundAt: "2026-05-29T10:00:00.000Z",
      memory: {},
    });
    const conversation = await memStore.upsertSocialConversation({
      companyId: "co_1",
      socialAccountId: account.id,
      platform: "instagram",
      externalThreadId: "thread_guarded",
      contactId: contact.id,
      metadata: {},
    });

    await expect(memStore.createSocialMessage({
      companyId: "co_1",
      conversationId: conversation.id,
      contactId: contact.id,
      direction: "outbound",
      kind: "dm",
      content: "Following up again",
      metadata: {},
    })).rejects.toThrow("Cannot send another DM before engagement");

    await memStore.updateSocialContact("co_1", contact.id, {
      optOutStatus: "opted_out",
      engagementState: "engaged",
    });

    await expect(memStore.createSocialMessage({
      companyId: "co_1",
      conversationId: conversation.id,
      contactId: contact.id,
      direction: "outbound",
      kind: "dm",
      content: "One more follow-up",
      metadata: {},
    })).rejects.toThrow("Contact has opted out");
  });
});
