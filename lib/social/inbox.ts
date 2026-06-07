import type {
  SocialContact,
  SocialContactEngagementState,
  SocialContactOptOutStatus,
  SocialContactPatch,
  SocialConversation,
  SocialMessage,
} from "./types";

export type SocialInboxStore = {
  listSocialConversations(companyId: string): Promise<SocialConversation[]>;
  getSocialContact(companyId: string, contactId: string): Promise<SocialContact | undefined | null>;
  listSocialMessagesForConversation(companyId: string, conversationId: string): Promise<SocialMessage[]>;
  updateSocialContact(companyId: string, contactId: string, patch: SocialContactPatch): Promise<SocialContact | undefined | null>;
};

export type SocialInboxReadStore = Pick<
  SocialInboxStore,
  "listSocialConversations" | "getSocialContact" | "listSocialMessagesForConversation"
>;

export type UnifiedInboxItem = {
  conversation: SocialConversation;
  contact?: SocialContact;
  latestMessage?: SocialMessage;
  messages: SocialMessage[];
};

export async function listUnifiedInbox(
  store: SocialInboxReadStore,
  companyId: string,
): Promise<UnifiedInboxItem[]> {
  const conversations = await store.listSocialConversations(companyId);
  const items = await Promise.all(conversations.map(async (conversation) => {
    const [contact, messages] = await Promise.all([
      conversation.contactId ? store.getSocialContact(companyId, conversation.contactId) : Promise.resolve(undefined),
      store.listSocialMessagesForConversation(companyId, conversation.id),
    ]);
    return {
      conversation,
      contact: contact ?? undefined,
      messages,
      latestMessage: latestMessage(messages),
    };
  }));

  return items.sort((a, b) => itemDate(b) - itemDate(a));
}

export async function updateSocialContactMemory(
  store: Pick<SocialInboxStore, "getSocialContact" | "updateSocialContact">,
  input: {
    companyId: string;
    contactId: string;
    memory: Record<string, unknown>;
    engagementState?: SocialContactEngagementState;
    optOutStatus?: SocialContactOptOutStatus;
  },
) {
  const existing = await store.getSocialContact(input.companyId, input.contactId);
  if (!existing) throw new Error("Social contact not found");
  const updated = await store.updateSocialContact(input.companyId, input.contactId, {
    memory: { ...existing.memory, ...input.memory },
    engagementState: input.engagementState,
    optOutStatus: input.optOutStatus,
  });
  if (!updated) throw new Error("Social contact not found");
  return updated;
}

function latestMessage(messages: SocialMessage[]) {
  return [...messages].sort((a, b) => messageDate(b) - messageDate(a))[0];
}

function itemDate(item: UnifiedInboxItem) {
  return Math.max(
    item.latestMessage ? messageDate(item.latestMessage) : 0,
    new Date(item.conversation.lastMessageAt ?? item.conversation.updatedAt).getTime(),
  );
}

function messageDate(message: SocialMessage) {
  return new Date(message.sentAt ?? message.createdAt).getTime();
}
