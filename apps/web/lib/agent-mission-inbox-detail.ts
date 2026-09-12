import type { AgentMissionEvent } from "@/lib/agent-mission-types";
import { listUnifiedInbox, type SocialInboxReadStore, type UnifiedInboxItem } from "@/lib/social/inbox";
import type { SocialContact, SocialConversation, SocialMessage, SocialOutreachDraft } from "@/lib/social/types";
import { store } from "@/lib/store";

export type MissionInboxEvidence = {
  summary: {
    conversations: number;
    inboundMessages: number;
    outboundMessages: number;
    replyDrafts: number;
    openConversations: number;
  };
  conversations: MissionInboxConversation[];
};

export type MissionInboxConversation = {
  conversationId: string;
  platform: SocialConversation["platform"];
  externalThreadId: string;
  status: SocialConversation["status"];
  lastMessageAt?: string;
  contact?: Pick<SocialContact, "id" | "handle" | "displayName" | "externalContactId" | "engagementState">;
  latestMessage?: MissionInboxMessage;
  messages: MissionInboxMessage[];
  replyDrafts: MissionInboxReplyDraft[];
};

export type MissionInboxMessage = Pick<SocialMessage, "id" | "direction" | "kind" | "content" | "sentAt" | "createdAt">;

export type MissionInboxReplyDraft = Pick<
  SocialOutreachDraft,
  "id" | "platform" | "purpose" | "status" | "approvalId" | "message"
>;

export async function listMissionInboxEvidence(input: {
  companyId: string;
  runId: string;
  events: AgentMissionEvent[];
  outreachDrafts: SocialOutreachDraft[];
  inboxStore?: SocialInboxReadStore;
}): Promise<MissionInboxEvidence> {
  const inbox = await listUnifiedInbox(input.inboxStore ?? missionInboxStore(), input.companyId);
  return buildMissionInboxEvidence({ ...input, inbox });
}

export function buildMissionInboxEvidence(input: {
  runId: string;
  events: AgentMissionEvent[];
  outreachDrafts: SocialOutreachDraft[];
  inbox: UnifiedInboxItem[];
}): MissionInboxEvidence {
  const missionContactIds = new Set(input.outreachDrafts.map((draft) => draft.contactId));
  const ingestedSocialAccountIds = new Set(input.events
    .filter((event) => event.kind === "social_inbox_ingested")
    .map((event) => stringValue(event.payload.socialAccountId))
    .filter((id): id is string => Boolean(id)));

  const conversations = input.inbox
    .filter((item) => isMissionInboxItem(item, missionContactIds, ingestedSocialAccountIds))
    .map((item) => formatConversation(item, input.outreachDrafts))
    .sort((a, b) => timeValue(b.lastMessageAt ?? b.latestMessage?.sentAt ?? b.latestMessage?.createdAt) - timeValue(a.lastMessageAt ?? a.latestMessage?.sentAt ?? a.latestMessage?.createdAt));

  return {
    summary: {
      conversations: conversations.length,
      inboundMessages: conversations.reduce((total, item) => total + item.messages.filter((message) => message.direction === "inbound").length, 0),
      outboundMessages: conversations.reduce((total, item) => total + item.messages.filter((message) => message.direction === "outbound").length, 0),
      replyDrafts: conversations.reduce((total, item) => total + item.replyDrafts.length, 0),
      openConversations: conversations.filter((item) => item.status === "open").length,
    },
    conversations,
  };
}

function missionInboxStore(): SocialInboxReadStore {
  return {
    listSocialConversations: store.listSocialConversations.bind(store),
    getSocialContact: store.getSocialContact.bind(store),
    listSocialMessagesForConversation: store.listSocialMessagesForConversation.bind(store),
  };
}

function isMissionInboxItem(
  item: UnifiedInboxItem,
  missionContactIds: Set<string>,
  ingestedSocialAccountIds: Set<string>,
) {
  return Boolean(
    (item.conversation.contactId && missionContactIds.has(item.conversation.contactId))
    || ingestedSocialAccountIds.has(item.conversation.socialAccountId),
  );
}

function formatConversation(item: UnifiedInboxItem, outreachDrafts: SocialOutreachDraft[]): MissionInboxConversation {
  const messages = [...item.messages]
    .sort((a, b) => timeValue(a.sentAt ?? a.createdAt) - timeValue(b.sentAt ?? b.createdAt))
    .map(formatMessage);
  return {
    conversationId: item.conversation.id,
    platform: item.conversation.platform,
    externalThreadId: item.conversation.externalThreadId,
    status: item.conversation.status,
    lastMessageAt: item.conversation.lastMessageAt,
    contact: item.contact ? {
      id: item.contact.id,
      handle: item.contact.handle,
      displayName: item.contact.displayName,
      externalContactId: item.contact.externalContactId,
      engagementState: item.contact.engagementState,
    } : undefined,
    latestMessage: item.latestMessage ? formatMessage(item.latestMessage) : undefined,
    messages,
    replyDrafts: outreachDrafts
      .filter((draft) => draft.contactId === item.conversation.contactId)
      .map((draft) => ({
        id: draft.id,
        platform: draft.platform,
        purpose: draft.purpose,
        status: draft.status,
        approvalId: draft.approvalId,
        message: draft.message,
      })),
  };
}

function formatMessage(message: SocialMessage): MissionInboxMessage {
  return {
    id: message.id,
    direction: message.direction,
    kind: message.kind,
    content: message.content,
    sentAt: message.sentAt,
    createdAt: message.createdAt,
  };
}

function timeValue(value?: string) {
  return value ? new Date(value).getTime() : 0;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
