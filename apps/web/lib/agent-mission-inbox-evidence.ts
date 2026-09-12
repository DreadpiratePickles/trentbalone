import type { AgentMissionPlan } from "@/lib/agent-mission-runtime";
import { getSocialPlatformAdapter, type SocialPlatformAdapter } from "@/lib/social/platform-adapter";
import { getSandboxSocialPlatformAdapter } from "@/lib/social/sandbox-adapters";
import { ingestSocialInbox, type SocialInboxIngestionResult } from "@/lib/social/inbox-ingestion";
import type { AgentMissionRun, Artifact, SocialAccount } from "@/lib/types";
import { store } from "@/lib/store";
import { nowIso } from "@/lib/utils";

export async function createInboxIngestionEvidence(
  run: AgentMissionRun,
  plan: AgentMissionPlan,
): Promise<Array<{
  kind: "inbox_ingestion";
  eventKind: "inbox_ingestion_ready";
  payload: Record<string, unknown>;
  artifact: Artifact;
}>> {
  if (!requiresInboxIngestion(run.objective, plan)) return [];

  const result = await ingestSocialInbox({
    companyId: run.companyId,
    missionRunId: run.id,
    since: run.startedAt,
    limit: 25,
    store,
    adapterFactory: missionInboxAdapter,
  });
  const artifact = await store.createArtifact({
    companyId: run.companyId,
    type: "campaign_report",
    status: "ready",
    title: "Inbox ingestion loop",
    summary: `Inbox ingestion checked ${result.accounts.length} social accounts, fetched ${result.fetchedMessages} messages, and imported ${result.importedMessages}.`,
    content: formatInboxIngestionArtifact(run, result),
    exportFormat: "markdown",
    storageKey: `agent-missions/${run.id}/loops/inbox-ingestion.md`,
    createdByAgent: "support",
    provenance: {
      prompt: run.objective,
      sources: [run.id, "inbox_ingestion"],
      model: "deterministic-agent-mission-inbox-ingestion",
      tokens: 0,
      costCents: 0,
      generatedAt: nowIso(),
    },
  });

  return [{
    kind: "inbox_ingestion",
    eventKind: "inbox_ingestion_ready",
    payload: {
      accountCount: result.accounts.length,
      fetchedMessages: result.fetchedMessages,
      importedMessages: result.importedMessages,
      skippedDuplicates: result.skippedDuplicates,
      blockedAccounts: result.accounts.filter((account) => account.status === "blocked").length,
      ingestedAccounts: result.accounts.filter((account) => account.status === "ingested").length,
    },
    artifact,
  }];
}

function requiresInboxIngestion(objective: string, plan: AgentMissionPlan) {
  return plan.approvalGates.includes("comment_or_dm_reply")
    || /\b(dm|dms|comment|comments|reply|replies|inbox|mention|mentions|engagement)\b/i.test(objective);
}

function missionInboxAdapter(platform: SocialAccount["platform"]): SocialPlatformAdapter {
  const mode = process.env.SOCIAL_INBOX_INGESTION_MODE;
  if (mode === "live") return getSocialPlatformAdapter(platform);
  if (mode === "sandbox") return getSandboxSocialPlatformAdapter(platform);
  return process.env.NODE_ENV === "production"
    ? getSocialPlatformAdapter(platform)
    : getSandboxSocialPlatformAdapter(platform);
}

function formatInboxIngestionArtifact(run: AgentMissionRun, result: SocialInboxIngestionResult) {
  return [
    "# Inbox ingestion loop",
    "",
    `Objective: ${run.objective}`,
    `Accounts checked: ${result.accounts.length}`,
    `Fetched messages: ${result.fetchedMessages}`,
    `Imported messages: ${result.importedMessages}`,
    `Skipped duplicates: ${result.skippedDuplicates}`,
    "",
    "## Account Results",
    "",
    result.accounts.length ? result.accounts.map(formatAccountResult).join("\n\n") : "No active social inbox accounts were available.",
    "",
    "Imported comments, mentions, and DMs stay inside Trent as memory and draft context. Replies and outbound messages still require approval before sending.",
  ].join("\n");
}

function formatAccountResult(account: SocialInboxIngestionResult["accounts"][number]) {
  return [
    `### ${account.platform} / ${account.socialAccountId}`,
    `- status: ${account.status}`,
    `- fetchedMessages: ${account.fetchedMessages}`,
    `- importedMessages: ${account.importedMessages}`,
    `- skippedDuplicates: ${account.skippedDuplicates}`,
    account.error ? `- error: ${account.error}` : undefined,
  ].filter(Boolean).join("\n");
}
