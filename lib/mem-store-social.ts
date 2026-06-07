import { state } from "./mem-store-state";
import { assertDirectMessageAllowed, nextContactStateAfterMessage, normalizeOptOutStatus } from "./social/anti-spam";
import type {
  SocialAccount,
  SocialAccountInput,
  SocialAnalyticsSnapshot,
  SocialAnalyticsSnapshotInput,
  SocialContact,
  SocialContactInput,
  SocialContactPatch,
  SocialConversation,
  SocialConversationInput,
  SocialConversationPatch,
  SocialMessage,
  SocialMessageInput,
  SocialOutreachDraft,
  SocialOutreachDraftInput,
  SocialOutreachDraftPatch,
  SocialPost,
  SocialPostInput,
  SocialPostPatch,
  SocialVoicePolicy,
  SocialVoicePolicyInput,
} from "./social/types";
import { makeId, nowIso } from "./utils";

type SocialState = {
  socialAccounts?: SocialAccount[];
  socialPosts?: SocialPost[];
  socialContacts?: SocialContact[];
  socialConversations?: SocialConversation[];
  socialMessages?: SocialMessage[];
  socialVoicePolicies?: SocialVoicePolicy[];
  socialAnalyticsSnapshots?: SocialAnalyticsSnapshot[];
  socialOutreachDrafts?: SocialOutreachDraft[];
};

type InitializedSocialState = Required<SocialState>;

function socialState() {
  const appState = state() as typeof state extends () => infer T ? T & SocialState : SocialState;
  appState.socialAccounts ??= [];
  appState.socialPosts ??= [];
  appState.socialContacts ??= [];
  appState.socialConversations ??= [];
  appState.socialMessages ??= [];
  appState.socialVoicePolicies ??= [];
  appState.socialAnalyticsSnapshots ??= [];
  appState.socialOutreachDrafts ??= [];
  return appState as InitializedSocialState;
}

export const memStoreSocial = {
  async upsertSocialAccount(input: SocialAccountInput): Promise<SocialAccount> {
    const appState = socialState();
    const existing = appState.socialAccounts.find(
      (account) =>
        account.companyId === input.companyId &&
        account.platform === input.platform &&
        account.externalAccountId === input.externalAccountId,
    );
    const timestamp = nowIso();

    if (existing) {
      Object.assign(existing, {
        status: input.status ?? existing.status,
        externalHandle: input.externalHandle ?? existing.externalHandle,
        displayName: input.displayName ?? existing.displayName,
        scopes: input.scopes,
        credentialsRef: input.credentialsRef ?? existing.credentialsRef,
        autoPublishEnabled: input.autoPublishEnabled ?? existing.autoPublishEnabled,
        updatedAt: timestamp,
      });
      return existing;
    }

    const created: SocialAccount = {
      id: makeId("socacct"),
      companyId: input.companyId,
      platform: input.platform,
      status: input.status ?? "active",
      externalAccountId: input.externalAccountId,
      externalHandle: input.externalHandle,
      displayName: input.displayName,
      scopes: input.scopes,
      credentialsRef: input.credentialsRef,
      autoPublishEnabled: input.autoPublishEnabled ?? false,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    appState.socialAccounts.push(created);
    return created;
  },

  async getSocialAccount(companyId: string, accountId: string): Promise<SocialAccount | undefined> {
    return socialState().socialAccounts.find((account) => account.companyId === companyId && account.id === accountId);
  },

  async listSocialAccounts(companyId: string): Promise<SocialAccount[]> {
    return socialState().socialAccounts.filter((account) => account.companyId === companyId);
  },

  async createSocialPost(input: SocialPostInput): Promise<SocialPost> {
    const timestamp = nowIso();
    const post: SocialPost = { ...input, id: makeId("socpost"), createdAt: timestamp, updatedAt: timestamp };
    socialState().socialPosts.push(post);
    return post;
  },

  async updateSocialPost(id: string, patch: SocialPostPatch): Promise<SocialPost | undefined> {
    const post = socialState().socialPosts.find((item) => item.id === id);
    if (!post) return undefined;
    Object.assign(post, patch, { updatedAt: nowIso() });
    return post;
  },

  async getSocialPost(id: string): Promise<SocialPost | undefined> {
    return socialState().socialPosts.find((post) => post.id === id);
  },

  async listSocialPosts(companyId: string): Promise<SocialPost[]> {
    return socialState().socialPosts.filter((post) => post.companyId === companyId);
  },

  async upsertSocialContact(input: SocialContactInput): Promise<SocialContact> {
    const appState = socialState();
    const existing = appState.socialContacts.find(
      (contact) =>
        contact.companyId === input.companyId &&
        contact.platform === input.platform &&
        contact.externalContactId === input.externalContactId,
    );
    const timestamp = nowIso();

    if (existing) {
      Object.assign(existing, {
        handle: input.handle ?? existing.handle,
        displayName: input.displayName ?? existing.displayName,
        profileUrl: input.profileUrl ?? existing.profileUrl,
        engagementState: input.engagementState ?? existing.engagementState,
        optOutStatus: input.optOutStatus ?? existing.optOutStatus,
        lastOutboundAt: input.lastOutboundAt ?? existing.lastOutboundAt,
        lastInboundAt: input.lastInboundAt ?? existing.lastInboundAt,
        memory: input.memory ?? existing.memory,
        updatedAt: timestamp,
      });
      return existing;
    }

    const created: SocialContact = {
      id: makeId("soccontact"),
      companyId: input.companyId,
      platform: input.platform,
      externalContactId: input.externalContactId,
      handle: input.handle,
      displayName: input.displayName,
      profileUrl: input.profileUrl,
      engagementState: input.engagementState ?? "unknown",
      optOutStatus: input.optOutStatus ?? "not_opted_out",
      lastOutboundAt: input.lastOutboundAt,
      lastInboundAt: input.lastInboundAt,
      memory: input.memory ?? {},
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    appState.socialContacts.push(created);
    return created;
  },

  async getSocialContact(companyId: string, contactId: string): Promise<SocialContact | undefined> {
    return socialState().socialContacts.find((contact) => contact.companyId === companyId && contact.id === contactId);
  },

  async listSocialContacts(companyId: string): Promise<SocialContact[]> {
    return socialState().socialContacts.filter((contact) => contact.companyId === companyId);
  },

  async updateSocialContact(
    companyId: string,
    contactId: string,
    patch: SocialContactPatch,
  ): Promise<SocialContact | undefined> {
    const contact = socialState().socialContacts.find((item) => item.companyId === companyId && item.id === contactId);
    if (!contact) return undefined;
    Object.assign(contact, patch, { updatedAt: nowIso() });
    return contact;
  },

  async upsertSocialConversation(input: SocialConversationInput): Promise<SocialConversation> {
    const appState = socialState();
    const existing = appState.socialConversations.find(
      (conversation) =>
        conversation.companyId === input.companyId &&
        conversation.platform === input.platform &&
        conversation.externalThreadId === input.externalThreadId,
    );
    const timestamp = nowIso();

    if (existing) {
      Object.assign(existing, {
        contactId: input.contactId ?? existing.contactId,
        status: input.status ?? existing.status,
        lastMessageAt: input.lastMessageAt ?? existing.lastMessageAt,
        metadata: input.metadata ?? existing.metadata,
        updatedAt: timestamp,
      });
      return existing;
    }

    const created: SocialConversation = {
      id: makeId("socconv"),
      companyId: input.companyId,
      socialAccountId: input.socialAccountId,
      platform: input.platform,
      externalThreadId: input.externalThreadId,
      contactId: input.contactId,
      status: input.status ?? "open",
      lastMessageAt: input.lastMessageAt,
      metadata: input.metadata ?? {},
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    appState.socialConversations.push(created);
    return created;
  },

  async updateSocialConversation(
    companyId: string,
    conversationId: string,
    patch: SocialConversationPatch,
  ): Promise<SocialConversation | undefined> {
    const conversation = socialState().socialConversations.find(
      (item) => item.companyId === companyId && item.id === conversationId,
    );
    if (!conversation) return undefined;
    Object.assign(conversation, patch, { updatedAt: nowIso() });
    return conversation;
  },

  async listSocialConversations(companyId: string): Promise<SocialConversation[]> {
    return socialState()
      .socialConversations
      .filter((conversation) => conversation.companyId === companyId)
      .sort((a, b) => comparableDate(b.lastMessageAt, b.updatedAt) - comparableDate(a.lastMessageAt, a.updatedAt));
  },

  async createSocialMessage(input: SocialMessageInput): Promise<SocialMessage> {
    const timestamp = nowIso();
    const appState = socialState();
    const contact = input.contactId
      ? appState.socialContacts.find((item) => item.companyId === input.companyId && item.id === input.contactId)
      : undefined;
    if (contact && input.direction === "outbound" && input.kind === "dm") assertDirectMessageAllowed(contact);

    const message: SocialMessage = { ...input, id: makeId("socmsg"), createdAt: timestamp, updatedAt: timestamp };
    appState.socialMessages.push(message);
    const messageAt = input.sentAt ?? timestamp;
    const conversation = appState.socialConversations.find(
      (item) => item.companyId === input.companyId && item.id === input.conversationId,
    );
    if (conversation) {
      conversation.lastMessageAt = messageAt;
      conversation.updatedAt = timestamp;
    }
    if (contact) {
      const nextState = nextContactStateAfterMessage(contact, input.direction);
      if (input.direction === "inbound") {
        contact.lastInboundAt = messageAt;
        contact.engagementState = nextState.engagementState;
        const optOutStatus = normalizeOptOutStatus(input.content);
        contact.optOutStatus = optOutStatus === "opted_out" ? optOutStatus : contact.optOutStatus;
      } else {
        contact.lastOutboundAt = messageAt;
        contact.engagementState = nextState.engagementState;
      }
      contact.updatedAt = timestamp;
    }
    return message;
  },

  async listSocialMessagesForConversation(companyId: string, conversationId: string): Promise<SocialMessage[]> {
    return socialState()
      .socialMessages
      .filter((message) => message.companyId === companyId && message.conversationId === conversationId)
      .sort((a, b) => comparableDate(a.sentAt, a.createdAt) - comparableDate(b.sentAt, b.createdAt));
  },

  async upsertSocialVoicePolicy(input: SocialVoicePolicyInput): Promise<SocialVoicePolicy> {
    const appState = socialState();
    const existing = appState.socialVoicePolicies.find((policy) => policy.companyId === input.companyId);
    const timestamp = nowIso();

    if (existing) {
      Object.assign(existing, { ...input, updatedAt: timestamp });
      return existing;
    }
    const created: SocialVoicePolicy = { ...input, id: makeId("socvoice"), createdAt: timestamp, updatedAt: timestamp };
    appState.socialVoicePolicies.push(created);
    return created;
  },

  async getSocialVoicePolicy(companyId: string): Promise<SocialVoicePolicy | undefined> {
    return socialState().socialVoicePolicies.find((policy) => policy.companyId === companyId);
  },

  async upsertSocialAnalyticsSnapshot(input: SocialAnalyticsSnapshotInput): Promise<SocialAnalyticsSnapshot> {
    const appState = socialState();
    const existing = appState.socialAnalyticsSnapshots.find(
      (snapshot) =>
        snapshot.socialAccountId === input.socialAccountId &&
        snapshot.periodStart === input.periodStart &&
        snapshot.periodEnd === input.periodEnd,
    );
    const timestamp = nowIso();

    if (existing) {
      Object.assign(existing, {
        companyId: input.companyId,
        platform: input.platform,
        metrics: input.metrics,
        report: input.report,
        updatedAt: timestamp,
      });
      return existing;
    }
    const snapshot: SocialAnalyticsSnapshot = {
      ...input,
      id: makeId("socanalytics"),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    appState.socialAnalyticsSnapshots.push(snapshot);
    return snapshot;
  },

  async listSocialAnalyticsSnapshots(companyId: string): Promise<SocialAnalyticsSnapshot[]> {
    return socialState().socialAnalyticsSnapshots.filter((snapshot) => snapshot.companyId === companyId);
  },

  async createSocialOutreachDraft(input: SocialOutreachDraftInput): Promise<SocialOutreachDraft> {
    const timestamp = nowIso();
    const draft: SocialOutreachDraft = { ...input, id: makeId("socoutreach"), createdAt: timestamp, updatedAt: timestamp };
    socialState().socialOutreachDrafts.push(draft);
    return draft;
  },

  async updateSocialOutreachDraft(id: string, patch: SocialOutreachDraftPatch): Promise<SocialOutreachDraft | undefined> {
    const draft = socialState().socialOutreachDrafts.find((item) => item.id === id);
    if (!draft) return undefined;
    Object.assign(draft, patch, { updatedAt: nowIso() });
    return draft;
  },

  async listSocialOutreachDrafts(companyId: string): Promise<SocialOutreachDraft[]> {
    return socialState().socialOutreachDrafts.filter((draft) => draft.companyId === companyId);
  },
};

function comparableDate(primary?: string, fallback?: string) {
  return new Date(primary ?? fallback ?? 0).getTime();
}
