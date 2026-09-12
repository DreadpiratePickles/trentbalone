import { db } from "@/lib/db";
import { assertDirectMessageAllowed, nextContactStateAfterMessage, normalizeOptOutStatus } from "./social/anti-spam";
import { makeId, nowIso } from "./utils";
import { toIso, toIsoReq } from "./prisma-store-mappers";
import type { SocialAccount, SocialAccountInput, SocialAnalyticsSnapshot, SocialAnalyticsSnapshotInput, SocialContact, SocialContactInput, SocialContactPatch, SocialConversation, SocialConversationInput, SocialConversationPatch, SocialMessage, SocialMessageInput, SocialOutreachDraft, SocialOutreachDraftInput, SocialOutreachDraftPatch, SocialPost, SocialPostInput, SocialPostPatch, SocialVoicePolicy, SocialVoicePolicyInput } from "./social/types";

const client = db as any;

function mapSocialAccount(row: any): SocialAccount {
  return {
    id: row.id,
    companyId: row.companyId,
    platform: row.platform,
    status: row.status,
    externalAccountId: row.externalAccountId,
    externalHandle: row.externalHandle ?? undefined,
    displayName: row.displayName ?? undefined,
    scopes: Array.isArray(row.scopes) ? row.scopes : [],
    credentialsRef: row.credentialsRef ?? undefined,
    autoPublishEnabled: row.autoPublishEnabled,
    createdAt: toIsoReq(row.createdAt),
    updatedAt: toIsoReq(row.updatedAt),
  };
}

function mapSocialPost(row: any): SocialPost {
  return {
    id: row.id,
    companyId: row.companyId,
    socialAccountId: row.socialAccountId,
    platform: row.platform,
    status: row.status,
    content: row.content,
    mediaUrls: Array.isArray(row.mediaUrls) ? row.mediaUrls : [],
    scheduledFor: toIso(row.scheduledFor),
    publishedAt: toIso(row.publishedAt),
    externalPostId: row.externalPostId ?? undefined,
    approvalId: row.approvalId ?? undefined,
    adaptedFromPostId: row.adaptedFromPostId ?? undefined,
    metadata: row.metadata ?? {},
    createdAt: toIsoReq(row.createdAt),
    updatedAt: toIsoReq(row.updatedAt),
  };
}

function mapSocialContact(row: any): SocialContact {
  return {
    id: row.id,
    companyId: row.companyId,
    platform: row.platform,
    externalContactId: row.externalContactId,
    handle: row.handle ?? undefined,
    displayName: row.displayName ?? undefined,
    profileUrl: row.profileUrl ?? undefined,
    engagementState: row.engagementState,
    optOutStatus: row.optOutStatus,
    lastOutboundAt: toIso(row.lastOutboundAt),
    lastInboundAt: toIso(row.lastInboundAt),
    memory: row.memory ?? {},
    createdAt: toIsoReq(row.createdAt),
    updatedAt: toIsoReq(row.updatedAt),
  };
}

function mapSocialConversation(row: any): SocialConversation {
  return {
    id: row.id,
    companyId: row.companyId,
    socialAccountId: row.socialAccountId,
    platform: row.platform,
    externalThreadId: row.externalThreadId,
    contactId: row.contactId ?? undefined,
    status: row.status,
    lastMessageAt: toIso(row.lastMessageAt),
    metadata: row.metadata ?? {},
    createdAt: toIsoReq(row.createdAt),
    updatedAt: toIsoReq(row.updatedAt),
  };
}

function mapSocialMessage(row: any): SocialMessage {
  return {
    id: row.id,
    companyId: row.companyId,
    conversationId: row.conversationId,
    contactId: row.contactId ?? undefined,
    direction: row.direction,
    kind: row.kind,
    content: row.content,
    externalMessageId: row.externalMessageId ?? undefined,
    sentAt: toIso(row.sentAt),
    metadata: row.metadata ?? {},
    createdAt: toIsoReq(row.createdAt),
    updatedAt: toIsoReq(row.updatedAt),
  };
}

function mapSocialVoicePolicy(row: any): SocialVoicePolicy {
  return {
    id: row.id,
    companyId: row.companyId,
    tone: row.tone,
    hashtagPolicy: row.hashtagPolicy,
    emojiPolicy: row.emojiPolicy,
    restrictedTerms: Array.isArray(row.restrictedTerms) ? row.restrictedTerms : [],
    platformGuidance: row.platformGuidance ?? {},
    createdAt: toIsoReq(row.createdAt),
    updatedAt: toIsoReq(row.updatedAt),
  };
}

function mapSocialAnalyticsSnapshot(row: any): SocialAnalyticsSnapshot {
  return {
    id: row.id,
    companyId: row.companyId,
    socialAccountId: row.socialAccountId,
    platform: row.platform,
    periodStart: toIsoReq(row.periodStart),
    periodEnd: toIsoReq(row.periodEnd),
    metrics: row.metrics ?? {},
    report: row.report ?? {},
    createdAt: toIsoReq(row.createdAt),
    updatedAt: toIsoReq(row.updatedAt),
  };
}

function mapSocialOutreachDraft(row: any): SocialOutreachDraft {
  return {
    id: row.id,
    companyId: row.companyId,
    contactId: row.contactId,
    platform: row.platform,
    purpose: row.purpose,
    message: row.message,
    status: row.status,
    approvalId: row.approvalId ?? undefined,
    riskFlags: Array.isArray(row.riskFlags) ? row.riskFlags : [],
    createdAt: toIsoReq(row.createdAt),
    updatedAt: toIsoReq(row.updatedAt),
  };
}

export const prismaStoreSocial = {
  async upsertSocialAccount(input: SocialAccountInput): Promise<SocialAccount> {
    const row = await client.socialAccount.upsert({
      where: {
        companyId_platform_externalAccountId: {
          companyId: input.companyId,
          platform: input.platform,
          externalAccountId: input.externalAccountId,
        },
      },
      update: {
        status: input.status ?? undefined,
        externalHandle: input.externalHandle ?? null,
        displayName: input.displayName ?? null,
        scopes: input.scopes,
        credentialsRef: input.credentialsRef ?? null,
        autoPublishEnabled: input.autoPublishEnabled ?? false,
      },
      create: {
        id: makeId("socacct"),
        companyId: input.companyId,
        platform: input.platform,
        status: input.status ?? "active",
        externalAccountId: input.externalAccountId,
        externalHandle: input.externalHandle ?? null,
        displayName: input.displayName ?? null,
        scopes: input.scopes,
        credentialsRef: input.credentialsRef ?? null,
        autoPublishEnabled: input.autoPublishEnabled ?? false,
      },
    });
    return mapSocialAccount(row);
  },

  async getSocialAccount(companyId: string, accountId: string): Promise<SocialAccount | undefined> {
    const row = await client.socialAccount.findFirst({ where: { id: accountId, companyId } });
    return row ? mapSocialAccount(row) : undefined;
  },

  async listSocialAccounts(companyId: string): Promise<SocialAccount[]> {
    const rows = await client.socialAccount.findMany({ where: { companyId }, orderBy: { createdAt: "desc" } });
    return rows.map(mapSocialAccount);
  },

  async createSocialPost(input: SocialPostInput): Promise<SocialPost> {
    const row = await client.socialPost.create({
      data: {
        id: makeId("socpost"),
        companyId: input.companyId,
        socialAccountId: input.socialAccountId,
        platform: input.platform,
        status: input.status,
        content: input.content,
        mediaUrls: input.mediaUrls,
        scheduledFor: input.scheduledFor ? new Date(input.scheduledFor) : null,
        publishedAt: input.publishedAt ? new Date(input.publishedAt) : null,
        externalPostId: input.externalPostId ?? null,
        approvalId: input.approvalId ?? null,
        adaptedFromPostId: input.adaptedFromPostId ?? null,
        metadata: input.metadata ?? {},
      },
    });
    return mapSocialPost(row);
  },

  async updateSocialPost(id: string, patch: SocialPostPatch): Promise<SocialPost | undefined> {
    const data: Record<string, unknown> = {};
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.content !== undefined) data.content = patch.content;
    if (patch.mediaUrls !== undefined) data.mediaUrls = patch.mediaUrls;
    if (patch.scheduledFor !== undefined) data.scheduledFor = patch.scheduledFor ? new Date(patch.scheduledFor) : null;
    if (patch.publishedAt !== undefined) data.publishedAt = patch.publishedAt ? new Date(patch.publishedAt) : null;
    if (patch.externalPostId !== undefined) data.externalPostId = patch.externalPostId ?? null;
    if (patch.approvalId !== undefined) data.approvalId = patch.approvalId ?? null;
    if (patch.adaptedFromPostId !== undefined) data.adaptedFromPostId = patch.adaptedFromPostId ?? null;
    if (patch.metadata !== undefined) data.metadata = patch.metadata;

    const row = await client.socialPost.update({ where: { id }, data }).catch(() => null);
    return row ? mapSocialPost(row) : undefined;
  },

  async getSocialPost(id: string): Promise<SocialPost | undefined> {
    const row = await client.socialPost.findUnique({ where: { id } });
    return row ? mapSocialPost(row) : undefined;
  },

  async listSocialPosts(companyId: string): Promise<SocialPost[]> {
    const rows = await client.socialPost.findMany({ where: { companyId }, orderBy: { createdAt: "desc" } });
    return rows.map(mapSocialPost);
  },

  async upsertSocialVoicePolicy(input: SocialVoicePolicyInput): Promise<SocialVoicePolicy> {
    const row = await client.socialVoicePolicy.upsert({
      where: { companyId: input.companyId },
      update: {
        tone: input.tone,
        hashtagPolicy: input.hashtagPolicy,
        emojiPolicy: input.emojiPolicy,
        restrictedTerms: input.restrictedTerms,
        platformGuidance: input.platformGuidance,
      },
      create: {
        id: makeId("socvoice"),
        companyId: input.companyId,
        tone: input.tone,
        hashtagPolicy: input.hashtagPolicy,
        emojiPolicy: input.emojiPolicy,
        restrictedTerms: input.restrictedTerms,
        platformGuidance: input.platformGuidance,
      },
    });
    return mapSocialVoicePolicy(row);
  },

  async getSocialVoicePolicy(companyId: string): Promise<SocialVoicePolicy | undefined> {
    const row = await client.socialVoicePolicy.findUnique({ where: { companyId } });
    return row ? mapSocialVoicePolicy(row) : undefined;
  },

  async upsertSocialContact(input: SocialContactInput): Promise<SocialContact> {
    const row = await client.socialContact.upsert({
      where: {
        companyId_platform_externalContactId: {
          companyId: input.companyId,
          platform: input.platform,
          externalContactId: input.externalContactId,
        },
      },
      update: {
        handle: input.handle ?? undefined,
        displayName: input.displayName ?? undefined,
        profileUrl: input.profileUrl ?? undefined,
        engagementState: input.engagementState ?? undefined,
        optOutStatus: input.optOutStatus ?? undefined,
        lastOutboundAt: input.lastOutboundAt ? new Date(input.lastOutboundAt) : undefined,
        lastInboundAt: input.lastInboundAt ? new Date(input.lastInboundAt) : undefined,
        memory: input.memory ?? undefined,
      },
      create: {
        id: makeId("soccontact"),
        companyId: input.companyId,
        platform: input.platform,
        externalContactId: input.externalContactId,
        handle: input.handle ?? null,
        displayName: input.displayName ?? null,
        profileUrl: input.profileUrl ?? null,
        engagementState: input.engagementState ?? "unknown",
        optOutStatus: input.optOutStatus ?? "not_opted_out",
        lastOutboundAt: input.lastOutboundAt ? new Date(input.lastOutboundAt) : null,
        lastInboundAt: input.lastInboundAt ? new Date(input.lastInboundAt) : null,
        memory: input.memory ?? {},
      },
    });
    return mapSocialContact(row);
  },

  async getSocialContact(companyId: string, contactId: string): Promise<SocialContact | undefined> {
    const row = await client.socialContact.findFirst({ where: { id: contactId, companyId } });
    return row ? mapSocialContact(row) : undefined;
  },

  async listSocialContacts(companyId: string): Promise<SocialContact[]> {
    const rows = await client.socialContact.findMany({ where: { companyId }, orderBy: { updatedAt: "desc" } });
    return rows.map(mapSocialContact);
  },

  async updateSocialContact(
    companyId: string,
    contactId: string,
    patch: SocialContactPatch,
  ): Promise<SocialContact | undefined> {
    const data: Record<string, unknown> = {};
    if (patch.handle !== undefined) data.handle = patch.handle ?? null;
    if (patch.displayName !== undefined) data.displayName = patch.displayName ?? null;
    if (patch.profileUrl !== undefined) data.profileUrl = patch.profileUrl ?? null;
    if (patch.engagementState !== undefined) data.engagementState = patch.engagementState;
    if (patch.optOutStatus !== undefined) data.optOutStatus = patch.optOutStatus;
    if (patch.lastOutboundAt !== undefined) data.lastOutboundAt = patch.lastOutboundAt ? new Date(patch.lastOutboundAt) : null;
    if (patch.lastInboundAt !== undefined) data.lastInboundAt = patch.lastInboundAt ? new Date(patch.lastInboundAt) : null;
    if (patch.memory !== undefined) data.memory = patch.memory;

    const existing = await client.socialContact.findFirst({ where: { id: contactId, companyId } });
    if (!existing) return undefined;
    const row = await client.socialContact.update({ where: { id: contactId }, data }).catch(() => null);
    return row ? mapSocialContact(row) : undefined;
  },

  async upsertSocialConversation(input: SocialConversationInput): Promise<SocialConversation> {
    const row = await client.socialConversation.upsert({
      where: {
        companyId_platform_externalThreadId: {
          companyId: input.companyId,
          platform: input.platform,
          externalThreadId: input.externalThreadId,
        },
      },
      update: {
        contactId: input.contactId ?? undefined,
        status: input.status ?? undefined,
        lastMessageAt: input.lastMessageAt ? new Date(input.lastMessageAt) : undefined,
        metadata: input.metadata ?? {},
      },
      create: {
        id: makeId("socconv"),
        companyId: input.companyId,
        socialAccountId: input.socialAccountId,
        platform: input.platform,
        externalThreadId: input.externalThreadId,
        contactId: input.contactId ?? null,
        status: input.status ?? "open",
        lastMessageAt: input.lastMessageAt ? new Date(input.lastMessageAt) : null,
        metadata: input.metadata ?? {},
      },
    });
    return mapSocialConversation(row);
  },

  async updateSocialConversation(
    companyId: string,
    conversationId: string,
    patch: SocialConversationPatch,
  ): Promise<SocialConversation | undefined> {
    const data: Record<string, unknown> = {};
    if (patch.contactId !== undefined) data.contactId = patch.contactId ?? null;
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.lastMessageAt !== undefined) data.lastMessageAt = patch.lastMessageAt ? new Date(patch.lastMessageAt) : null;
    if (patch.metadata !== undefined) data.metadata = patch.metadata;

    const existing = await client.socialConversation.findFirst({ where: { id: conversationId, companyId } });
    if (!existing) return undefined;
    const row = await client.socialConversation.update({ where: { id: conversationId }, data }).catch(() => null);
    return row ? mapSocialConversation(row) : undefined;
  },

  async listSocialConversations(companyId: string): Promise<SocialConversation[]> {
    const rows = await client.socialConversation.findMany({
      where: { companyId },
      orderBy: [{ lastMessageAt: "desc" }, { updatedAt: "desc" }],
    });
    return rows.map(mapSocialConversation);
  },

  async createSocialMessage(input: SocialMessageInput): Promise<SocialMessage> {
    const contact = input.contactId
      ? await client.socialContact.findFirst({ where: { id: input.contactId, companyId: input.companyId } })
      : null;
    if (contact && input.direction === "outbound" && input.kind === "dm") {
      assertDirectMessageAllowed(mapSocialContact(contact));
    }
    const row = await client.socialMessage.create({
      data: {
        id: makeId("socmsg"),
        companyId: input.companyId,
        conversationId: input.conversationId,
        contactId: input.contactId ?? null,
        direction: input.direction,
        kind: input.kind,
        content: input.content,
        externalMessageId: input.externalMessageId ?? null,
        sentAt: input.sentAt ? new Date(input.sentAt) : null,
        metadata: input.metadata ?? {},
      },
    });
    const messageAt = input.sentAt ?? nowIso();
    await client.socialConversation.update({
      where: { id: input.conversationId },
      data: { lastMessageAt: new Date(messageAt) },
    }).catch(() => null);
    if (contact) {
      const mappedContact = mapSocialContact(contact);
      const nextState = nextContactStateAfterMessage(mappedContact, input.direction);
      await client.socialContact.update({
        where: { id: contact.id },
        data: input.direction === "inbound"
          ? {
            lastInboundAt: new Date(messageAt),
            engagementState: nextState.engagementState,
            ...(normalizeOptOutStatus(input.content) === "opted_out" ? { optOutStatus: "opted_out" } : {}),
          }
          : {
            lastOutboundAt: new Date(messageAt),
            engagementState: nextState.engagementState,
          },
      }).catch(() => null);
    }
    return mapSocialMessage(row);
  },

  async listSocialMessagesForConversation(companyId: string, conversationId: string): Promise<SocialMessage[]> {
    const rows = await client.socialMessage.findMany({
      where: { companyId, conversationId },
      orderBy: [{ sentAt: "asc" }, { createdAt: "asc" }],
    });
    return rows.map(mapSocialMessage);
  },

  async upsertSocialAnalyticsSnapshot(input: SocialAnalyticsSnapshotInput): Promise<SocialAnalyticsSnapshot> {
    const row = await client.socialAnalyticsSnapshot.upsert({
      where: {
        socialAccountId_periodStart_periodEnd: {
          socialAccountId: input.socialAccountId,
          periodStart: new Date(input.periodStart),
          periodEnd: new Date(input.periodEnd),
        },
      },
      update: { companyId: input.companyId, platform: input.platform, metrics: input.metrics, report: input.report },
      create: {
        id: makeId("socanalytics"),
        companyId: input.companyId,
        socialAccountId: input.socialAccountId,
        platform: input.platform,
        periodStart: new Date(input.periodStart),
        periodEnd: new Date(input.periodEnd),
        metrics: input.metrics,
        report: input.report,
      },
    });
    return mapSocialAnalyticsSnapshot(row);
  },

  async listSocialAnalyticsSnapshots(companyId: string): Promise<SocialAnalyticsSnapshot[]> {
    const rows = await client.socialAnalyticsSnapshot.findMany({
      where: { companyId },
      orderBy: { periodStart: "desc" },
    });
    return rows.map(mapSocialAnalyticsSnapshot);
  },

  async createSocialOutreachDraft(input: SocialOutreachDraftInput): Promise<SocialOutreachDraft> {
    const row = await client.socialOutreachDraft.create({
      data: { id: makeId("socoutreach"), companyId: input.companyId, contactId: input.contactId, platform: input.platform, purpose: input.purpose, message: input.message, status: input.status, approvalId: input.approvalId ?? null, riskFlags: input.riskFlags },
    });
    return mapSocialOutreachDraft(row);
  },

  async updateSocialOutreachDraft(id: string, patch: SocialOutreachDraftPatch): Promise<SocialOutreachDraft | undefined> {
    const data: Record<string, unknown> = {};
    if (patch.purpose !== undefined) data.purpose = patch.purpose;
    if (patch.message !== undefined) data.message = patch.message;
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.approvalId !== undefined) data.approvalId = patch.approvalId ?? null;
    if (patch.riskFlags !== undefined) data.riskFlags = patch.riskFlags;

    const row = await client.socialOutreachDraft.update({ where: { id }, data }).catch(() => null);
    return row ? mapSocialOutreachDraft(row) : undefined;
  },

  async listSocialOutreachDrafts(companyId: string): Promise<SocialOutreachDraft[]> {
    return (await client.socialOutreachDraft.findMany({ where: { companyId }, orderBy: { createdAt: "desc" } })).map(mapSocialOutreachDraft);
  },
};
