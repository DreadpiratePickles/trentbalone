import { getSocialPlatformAdapter, type SocialInboxMessage, type SocialPlatformAdapter } from "./platform-adapter";
import type {
  SocialAccount,
  SocialContact,
  SocialContactInput,
  SocialConversation,
  SocialConversationInput,
  SocialMessage,
  SocialMessageInput,
} from "./types";
import { store as appStore } from "@/lib/store";

export type SocialInboxIngestionStore = {
  listSocialAccounts(companyId: string): Promise<SocialAccount[]>;
  upsertSocialContact(input: SocialContactInput): Promise<SocialContact>;
  upsertSocialConversation(input: SocialConversationInput): Promise<SocialConversation>;
  listSocialMessagesForConversation(companyId: string, conversationId: string): Promise<SocialMessage[]>;
  createSocialMessage(input: SocialMessageInput): Promise<SocialMessage>;
  appendAgentMissionEvent?(input: {
    runId: string;
    companyId: string;
    kind: string;
    payload: Record<string, unknown>;
    stepId?: string;
  }): Promise<unknown>;
};

export type SocialInboxIngestionAccountResult = {
  socialAccountId: string;
  platform: SocialAccount["platform"];
  status: "ingested" | "blocked" | "skipped";
  fetchedMessages: number;
  importedMessages: number;
  skippedDuplicates: number;
  error?: string;
};

export type SocialInboxIngestionResult = {
  companyId: string;
  accounts: SocialInboxIngestionAccountResult[];
  fetchedMessages: number;
  importedMessages: number;
  skippedDuplicates: number;
};

export type SocialInboxIngestionInput = {
  companyId: string;
  socialAccountId?: string;
  missionRunId?: string;
  since?: string;
  limit?: number;
  store?: SocialInboxIngestionStore;
  adapterFactory?: (platform: SocialAccount["platform"]) => SocialPlatformAdapter;
};

export async function ingestSocialInbox(input: SocialInboxIngestionInput): Promise<SocialInboxIngestionResult> {
  const socialStore = input.store ?? requireSocialInboxIngestionStore();
  const adapterFactory = input.adapterFactory ?? getSocialPlatformAdapter;
  const accounts = (await socialStore.listSocialAccounts(input.companyId))
    .filter((account) => account.status === "active")
    .filter((account) => !input.socialAccountId || account.id === input.socialAccountId);

  const results: SocialInboxIngestionAccountResult[] = [];
  for (const account of accounts) {
    const adapter = adapterFactory(account.platform);
    try {
      const fetched = await adapter.fetchInbox({
        companyId: input.companyId,
        socialAccountId: account.id,
        externalAccountId: account.externalAccountId,
        since: input.since,
        limit: input.limit,
      });
      let importedMessages = 0;
      let skippedDuplicates = 0;
      for (const message of fetched.messages) {
        const imported = await importInboxMessage(socialStore, account, message);
        if (imported) importedMessages += 1;
        else skippedDuplicates += 1;
      }
      const result: SocialInboxIngestionAccountResult = {
        socialAccountId: account.id,
        platform: account.platform,
        status: "ingested",
        fetchedMessages: fetched.messages.length,
        importedMessages,
        skippedDuplicates,
      };
      results.push(result);
      await appendMissionEvent(socialStore, input, "social_inbox_ingested", {
        socialAccountId: account.id,
        platform: account.platform,
        fetchedMessages: fetched.messages.length,
        importedMessages,
        skippedDuplicates,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const result: SocialInboxIngestionAccountResult = {
        socialAccountId: account.id,
        platform: account.platform,
        status: "blocked",
        fetchedMessages: 0,
        importedMessages: 0,
        skippedDuplicates: 0,
        error: message,
      };
      results.push(result);
      await appendMissionEvent(socialStore, input, "social_inbox_ingest_blocked", {
        socialAccountId: account.id,
        platform: account.platform,
        error: message,
      });
    }
  }

  return {
    companyId: input.companyId,
    accounts: results,
    fetchedMessages: sum(results, "fetchedMessages"),
    importedMessages: sum(results, "importedMessages"),
    skippedDuplicates: sum(results, "skippedDuplicates"),
  };
}

async function importInboxMessage(
  store: SocialInboxIngestionStore,
  account: SocialAccount,
  message: SocialInboxMessage,
) {
  const contact = await store.upsertSocialContact({
    companyId: account.companyId,
    platform: account.platform,
    externalContactId: message.externalContactId,
    handle: typeof message.metadata?.username === "string" ? message.metadata.username : undefined,
    displayName: typeof message.metadata?.fromName === "string" ? message.metadata.fromName : undefined,
    lastInboundAt: message.direction === "inbound" ? message.sentAt : undefined,
    memory: {
      source: "social_inbox_ingestion",
      platform: account.platform,
      lastMessageKind: message.kind,
    },
  });
  const conversation = await store.upsertSocialConversation({
    companyId: account.companyId,
    socialAccountId: account.id,
    platform: account.platform,
    externalThreadId: message.externalThreadId,
    contactId: contact.id,
    lastMessageAt: message.sentAt,
    metadata: {
      source: "social_inbox_ingestion",
      latestExternalMessageId: message.externalMessageId,
    },
  });
  const existing = await store.listSocialMessagesForConversation(account.companyId, conversation.id);
  if (existing.some((item) => item.externalMessageId === message.externalMessageId)) return false;
  await store.createSocialMessage({
    companyId: account.companyId,
    conversationId: conversation.id,
    contactId: contact.id,
    direction: message.direction,
    kind: message.kind,
    content: message.content,
    externalMessageId: message.externalMessageId,
    sentAt: message.sentAt,
    metadata: message.metadata ?? {},
  });
  return true;
}

async function appendMissionEvent(
  store: SocialInboxIngestionStore,
  input: SocialInboxIngestionInput,
  kind: string,
  payload: Record<string, unknown>,
) {
  if (!input.missionRunId || typeof store.appendAgentMissionEvent !== "function") return;
  await store.appendAgentMissionEvent({
    runId: input.missionRunId,
    companyId: input.companyId,
    kind,
    payload,
  });
}

function requireSocialInboxIngestionStore(): SocialInboxIngestionStore {
  const socialStore = appStore as typeof appStore & Partial<SocialInboxIngestionStore>;
  if (
    typeof socialStore.listSocialAccounts !== "function" ||
    typeof socialStore.upsertSocialContact !== "function" ||
    typeof socialStore.upsertSocialConversation !== "function" ||
    typeof socialStore.listSocialMessagesForConversation !== "function" ||
    typeof socialStore.createSocialMessage !== "function"
  ) {
    throw new Error("Social inbox ingestion store methods are not available");
  }
  return socialStore as typeof appStore & SocialInboxIngestionStore;
}

function sum(items: SocialInboxIngestionAccountResult[], field: "fetchedMessages" | "importedMessages" | "skippedDuplicates") {
  return items.reduce((total, item) => total + item[field], 0);
}
