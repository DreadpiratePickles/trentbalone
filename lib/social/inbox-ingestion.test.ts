import { describe, expect, it, vi } from "vitest";
import { ingestSocialInbox, type SocialInboxIngestionStore } from "./inbox-ingestion";
import type { SocialAccount, SocialConversation, SocialMessage } from "./types";

describe("ingestSocialInbox", () => {
  it("fetches live inbox messages, upserts contacts/conversations, skips duplicates, and emits mission events", async () => {
    const createdMessages: SocialMessage[] = [];
    const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    const conversations = new Map<string, SocialConversation>();
    const account = socialAccount();
    const store: SocialInboxIngestionStore = {
      listSocialAccounts: vi.fn(async () => [account]),
      upsertSocialContact: vi.fn(async (input) => ({
        id: "contact_1",
        ...input,
        engagementState: input.engagementState ?? "unknown",
        optOutStatus: input.optOutStatus ?? "not_opted_out",
        memory: input.memory ?? {},
        createdAt: "2026-06-06T12:00:00.000Z",
        updatedAt: "2026-06-06T12:00:00.000Z",
      })),
      upsertSocialConversation: vi.fn(async (input) => {
        const existing = conversations.get(input.externalThreadId);
        if (existing) return existing;
        const conversation = {
          id: `conv_${conversations.size + 1}`,
          ...input,
          status: input.status ?? "open",
          createdAt: "2026-06-06T12:00:00.000Z",
          updatedAt: "2026-06-06T12:00:00.000Z",
        };
        conversations.set(input.externalThreadId, conversation);
        return conversation;
      }),
      listSocialMessagesForConversation: vi.fn(async () => createdMessages),
      createSocialMessage: vi.fn(async (input) => {
        const message = {
          id: `msg_${createdMessages.length + 1}`,
          ...input,
          createdAt: "2026-06-06T12:00:00.000Z",
          updatedAt: "2026-06-06T12:00:00.000Z",
        };
        createdMessages.push(message);
        return message;
      }),
      appendAgentMissionEvent: vi.fn(async (input) => {
        events.push({ kind: input.kind, payload: input.payload });
        return {
          id: "ame_1",
          seq: events.length,
          createdAt: "2026-06-06T12:00:00.000Z",
          ...input,
        };
      }),
    };

    const result = await ingestSocialInbox({
      companyId: "co_1",
      missionRunId: "amr_1",
      store,
      adapterFactory: () => ({
        platform: "x",
        capabilities: {} as never,
        createPostDraft: vi.fn() as never,
        publishPost: vi.fn() as never,
        reply: vi.fn() as never,
        sendDm: vi.fn() as never,
        fetchInbox: vi.fn(async () => ({
          platform: "x" as const,
          status: "fetched" as const,
          messages: [
            {
              externalMessageId: "tweet_1",
              externalThreadId: "thread_1",
              externalContactId: "lead_1",
              direction: "inbound" as const,
              kind: "mention" as const,
              content: "Interested in this",
              sentAt: "2026-06-06T12:00:00.000Z",
            },
            {
              externalMessageId: "tweet_1",
              externalThreadId: "thread_1",
              externalContactId: "lead_1",
              direction: "inbound" as const,
              kind: "mention" as const,
              content: "Duplicate",
              sentAt: "2026-06-06T12:00:00.000Z",
            },
          ],
        })),
        fetchAnalytics: vi.fn() as never,
        deleteOrHideContent: vi.fn() as never,
      }),
    });

    expect(result.importedMessages).toBe(1);
    expect(result.skippedDuplicates).toBe(1);
    expect(store.upsertSocialContact).toHaveBeenCalledWith(expect.objectContaining({
      externalContactId: "lead_1",
      lastInboundAt: "2026-06-06T12:00:00.000Z",
    }));
    expect(store.createSocialMessage).toHaveBeenCalledTimes(1);
    expect(events[0]).toMatchObject({
      kind: "social_inbox_ingested",
      payload: { importedMessages: 1, fetchedMessages: 2 },
    });
  });

  it("records provider blockers without throwing the whole ingestion run", async () => {
    const result = await ingestSocialInbox({
      companyId: "co_1",
      store: {
        listSocialAccounts: vi.fn(async () => [socialAccount()]),
        upsertSocialContact: vi.fn() as never,
        upsertSocialConversation: vi.fn() as never,
        listSocialMessagesForConversation: vi.fn() as never,
        createSocialMessage: vi.fn() as never,
      },
      adapterFactory: () => ({
        platform: "x",
        capabilities: {} as never,
        createPostDraft: vi.fn() as never,
        publishPost: vi.fn() as never,
        reply: vi.fn() as never,
        sendDm: vi.fn() as never,
        fetchInbox: vi.fn(async () => {
          throw new Error("rate limited");
        }),
        fetchAnalytics: vi.fn() as never,
        deleteOrHideContent: vi.fn() as never,
      }),
    });

    expect(result.accounts[0]).toMatchObject({ status: "blocked", error: "rate limited" });
  });
});

function socialAccount(): SocialAccount {
  return {
    id: "soc_1",
    companyId: "co_1",
    platform: "x",
    status: "active",
    externalAccountId: "user_1",
    scopes: ["post:write"],
    autoPublishEnabled: false,
    createdAt: "2026-06-06T12:00:00.000Z",
    updatedAt: "2026-06-06T12:00:00.000Z",
  };
}
