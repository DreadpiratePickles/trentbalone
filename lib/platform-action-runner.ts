import { executeAdsLaunch } from "@/lib/platform-action-ads";
import { auditAgentMissionPlatformAction } from "@/lib/agent-mission-audit";
import { isMarketingPlatform, type MarketingPlatformAdapter } from "@/lib/marketing/platform-adapter";
import {
  isPlatformActionLiveMode,
  labelSimulatedAction,
  platformActionExecutionMode,
  resolvePlatformActionExecutionMode,
} from "@/lib/platform-action-mode";
import { refreshPlatformOAuthConnection, type PlatformOAuthKind, type PlatformOAuthPlatform } from "@/lib/platform-oauth";
import { getSandboxSocialPlatformAdapter } from "@/lib/social/sandbox-adapters";
import { getSocialPlatformAdapter, isSocialPlatform, type SocialPlatformAdapter } from "@/lib/social/platform-adapter";
import { store } from "@/lib/store";
import type { JobRun, MarketingPlatform, SocialPlatform } from "@/lib/types";
import { nowIso } from "@/lib/utils";

export type PlatformActionExecutionResult = {
  status: "completed" | "failed" | "skipped";
  jobRun: JobRun;
  externalRef?: string;
  error?: string;
  errorCode?: string;
  errorKind?: PlatformActionErrorKind;
  retryAfterSeconds?: number;
  oauthRefresh?: PlatformActionOAuthRefreshEvidence;
};

export type PlatformActionErrorKind =
  | "needs_credentials"
  | "expired_token"
  | "rate_limited"
  | "rejected_creative"
  | "partial_publication"
  | "unsupported_operation"
  | "provider_error";

type PlatformActionMetadata = {
  kind: "agent_mission_platform_action";
  runId: string;
  approvalId: string;
  gate: string;
  action: string;
  platform: string;
  provider: string;
  targetId: string;
  payload?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: string;
};

type PlatformActionRunnerDeps = {
  socialAdapterFor?: (platform: SocialPlatform) => SocialPlatformAdapter;
  marketingAdapterFor?: (platform: MarketingPlatform) => MarketingPlatformAdapter;
  oauthRefresh?: (input: PlatformActionOAuthRefreshInput) => Promise<PlatformActionOAuthRefreshResult>;
};

type PlatformActionOAuthRefreshInput = {
  companyId: string;
  kind: PlatformOAuthKind;
  platform: PlatformOAuthPlatform;
};

type PlatformActionOAuthRefreshResult = {
  status: string;
  kind?: PlatformOAuthKind;
  platform?: PlatformOAuthPlatform;
};

type PlatformActionOAuthRefreshEvidence = {
  attempted: true;
  status: string;
  kind: PlatformOAuthKind;
  platform: PlatformOAuthPlatform;
};

export async function executeQueuedPlatformAction(
  jobRunId: string,
  deps: PlatformActionRunnerDeps = {},
): Promise<PlatformActionExecutionResult> {
  const jobRun = await store.getJobRun(jobRunId);
  if (!jobRun) throw new Error(`Platform action job not found: ${jobRunId}`);
  if (jobRun.type !== "platform_action") return { status: "skipped", jobRun };
  if (jobRun.status !== "running") return { status: "skipped", jobRun };

  const metadata = parsePlatformActionMetadata(jobRun.metadata);
  if (!metadata) {
    return failJob(jobRun, "Platform action metadata is invalid");
  }

  try {
    const result = await executeByActionWithOAuthRetry(jobRun, metadata, deps);
    const executionMode = resolvePlatformActionExecutionMode({
      executionMode: result.executionMode,
      externalRef: result.externalRef,
    });
    const updated = await store.updateJobRun(jobRun.id, {
      status: "completed",
      completedAt: nowIso(),
      summary: labelSimulatedAction(
        `Completed platform action: ${metadata.action} ${metadata.platform}`,
        executionMode,
      ),
      resultCount: 1,
      metadata: {
        ...jobRun.metadata,
        executionMode,
        result: {
          ...result,
          executionMode,
        },
      },
    });
    if (jobRun.companyId) {
      await auditAgentMissionPlatformAction({
        companyId: jobRun.companyId,
        runId: metadata.runId,
        jobRunId: jobRun.id,
        action: metadata.action,
        platform: metadata.platform,
        status: "completed",
        externalRef: result.externalRef,
        executionMode,
      });
    }
    return {
      status: "completed",
      jobRun: updated ?? jobRun,
      externalRef: result.externalRef,
      oauthRefresh: oauthRefreshEvidence(result),
    };
  } catch (error) {
    if (jobRun.companyId) {
      const detail = platformActionErrorDetail(error);
      await auditAgentMissionPlatformAction({
        companyId: jobRun.companyId,
        runId: metadata.runId,
        jobRunId: jobRun.id,
        action: metadata.action,
        platform: metadata.platform,
        status: "failed",
        executionMode: platformActionExecutionMode(),
        error: detail.message,
      });
    }
    return failJob(jobRun, error);
  }
}

async function executeByActionWithOAuthRetry(
  jobRun: JobRun,
  metadata: PlatformActionMetadata,
  deps: PlatformActionRunnerDeps,
): Promise<Record<string, unknown> & { externalRef?: string }> {
  try {
    return await executeByAction(jobRun, metadata, deps);
  } catch (error) {
    const detail = platformActionErrorDetail(error);
    if (detail.kind !== "expired_token") throw error;
    const oauthRefresh = await refreshOAuthCredentialForAction(jobRun, metadata, deps, detail.message);
    const retryResult = await executeByAction(jobRun, metadata, deps);
    return { ...retryResult, oauthRefresh };
  }
}

async function refreshOAuthCredentialForAction(
  jobRun: JobRun,
  metadata: PlatformActionMetadata,
  deps: PlatformActionRunnerDeps,
  originalError: string,
): Promise<PlatformActionOAuthRefreshEvidence> {
  const request = oauthRefreshRequest(jobRun, metadata);
  if (!request) throw expiredTokenRefreshError(`OAuth refresh is not available for ${metadata.action} ${metadata.platform}`);
  const refresh = deps.oauthRefresh ?? refreshPlatformOAuthConnection;
  try {
    const result = await refresh(request);
    return {
      attempted: true,
      status: result.status,
      kind: request.kind,
      platform: request.platform,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw expiredTokenRefreshError(`OAuth refresh failed before retry: ${detail}; original error: ${originalError}`);
  }
}

function oauthRefreshRequest(
  jobRun: JobRun,
  metadata: PlatformActionMetadata,
): PlatformActionOAuthRefreshInput | undefined {
  if (!jobRun.companyId) return undefined;
  if (metadata.action === "ads.launch") {
    if (!isMarketingPlatform(metadata.platform)) return undefined;
    return { companyId: jobRun.companyId, kind: "ads", platform: metadata.platform };
  }
  if (!isSocialPlatform(metadata.platform)) return undefined;
  return { companyId: jobRun.companyId, kind: "social", platform: metadata.platform };
}

function expiredTokenRefreshError(message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = "expired_token";
  return error;
}

function oauthRefreshEvidence(result: Record<string, unknown>): PlatformActionOAuthRefreshEvidence | undefined {
  const refresh = result.oauthRefresh;
  if (!refresh || typeof refresh !== "object") return undefined;
  const record = refresh as Partial<PlatformActionOAuthRefreshEvidence>;
  return record.attempted === true
    && typeof record.status === "string"
    && (record.kind === "social" || record.kind === "ads")
    && typeof record.platform === "string"
    ? {
    attempted: true,
    status: record.status,
    kind: record.kind,
    platform: record.platform as PlatformOAuthPlatform,
  } : undefined;
}

async function executeByAction(
  jobRun: JobRun,
  metadata: PlatformActionMetadata,
  deps: PlatformActionRunnerDeps,
): Promise<Record<string, unknown> & { externalRef?: string }> {
  if (metadata.action === "social.publish") {
    return executeSocialPublish(jobRun.id, metadata, deps);
  }
  if (metadata.action === "ads.launch") {
    return executeAdsLaunch(metadata, deps);
  }
  if (metadata.action === "social.reply") {
    return executeOutboundDraft(jobRun, metadata, deps, "reply");
  }
  if (metadata.action === "sales.outreach_send") {
    return executeOutboundDraft(jobRun, metadata, deps, "dm");
  }
  throw new Error(`Unsupported platform action: ${metadata.action}`);
}

async function executeSocialPublish(
  jobRunId: string,
  metadata: PlatformActionMetadata,
  deps: PlatformActionRunnerDeps,
): Promise<Record<string, unknown> & { externalRef: string }> {
  if (!isSocialPlatform(metadata.platform)) throw new Error(`Unsupported social platform: ${metadata.platform}`);
  const post = await store.getSocialPost(metadata.targetId);
  if (!post) throw new Error(`Social post not found: ${metadata.targetId}`);
  const account = await store.getSocialAccount(post.companyId, post.socialAccountId);
  if (!account) throw new Error(`Social account not found: ${post.socialAccountId}`);

  const adapter = deps.socialAdapterFor?.(metadata.platform) ?? defaultSocialAdapter(metadata.platform);
  if (!adapter.capabilities.posts) throw new Error(`${metadata.provider} does not support social publishing`);
  const published = await adapter.publishPost({
    companyId: post.companyId,
    postId: post.id,
    socialAccountId: account.id,
    externalAccountId: account.externalAccountId,
    content: post.content,
    mediaUrls: post.mediaUrls,
    approvalId: post.approvalId,
    metadata: {
      providerActionId: jobRunId,
      runId: metadata.runId,
    },
  });

  await store.updateSocialPost(post.id, {
    status: "published",
    externalPostId: published.externalPostId,
    publishedAt: published.publishedAt,
    metadata: {
      ...post.metadata,
      executionMode: resolvePlatformActionExecutionMode({
        externalRef: published.externalPostId,
      }),
      simulated: !isPlatformActionLiveMode(),
      providerAction: {
        jobRunId,
        externalRef: published.externalPostId,
        provider: metadata.provider,
        executionMode: resolvePlatformActionExecutionMode({
          externalRef: published.externalPostId,
        }),
      },
    },
  });

  return {
    externalRef: published.externalPostId,
    status: published.status,
    publishedAt: published.publishedAt,
    platform: published.platform,
    executionMode: resolvePlatformActionExecutionMode({
      externalRef: published.externalPostId,
    }),
  };
}

async function executeOutboundDraft(
  jobRun: JobRun,
  metadata: PlatformActionMetadata,
  deps: PlatformActionRunnerDeps,
  mode: "reply" | "dm",
): Promise<Record<string, unknown> & { externalRef: string }> {
  if (!isSocialPlatform(metadata.platform)) throw new Error(`Unsupported social platform: ${metadata.platform}`);
  if (!jobRun.companyId) throw new Error(`Platform action companyId is missing: ${jobRun.id}`);
  const draft = (await store.listSocialOutreachDrafts(jobRun.companyId))
    .find((item) => item.id === metadata.targetId);
  if (!draft) throw new Error(`Social outreach draft not found: ${metadata.targetId}`);
  const account = (await store.listSocialAccounts(draft.companyId))
    .find((item) => item.platform === draft.platform && item.status === "active" && item.credentialsRef);
  if (!account) throw new Error(`Social account not found for ${draft.platform}`);
  const contact = await store.getSocialContact(draft.companyId, draft.contactId);
  if (!contact) throw new Error(`Social contact not found for ${draft.contactId}`);

  const adapter = deps.socialAdapterFor?.(metadata.platform) ?? defaultSocialAdapter(metadata.platform);
  if (mode === "reply" && !adapter.capabilities.replies) throw new Error(`${metadata.provider} does not support replies`);
  if (mode === "dm" && !adapter.capabilities.dms) throw new Error(`${metadata.provider} does not support DMs`);

  if (mode === "reply") {
    const conversation = (await store.listSocialConversations(draft.companyId))
      .filter((item) => item.socialAccountId === account.id && item.contactId === contact.id)
      .sort((a, b) => comparableTime(b.lastMessageAt, b.updatedAt) - comparableTime(a.lastMessageAt, a.updatedAt))[0];
    const sent = await adapter.reply({
      companyId: draft.companyId,
      socialAccountId: account.id,
      externalAccountId: account.externalAccountId,
      externalThreadId: conversation?.externalThreadId ?? contact.externalContactId,
      content: draft.message,
      metadata: { providerActionId: jobRun.id, runId: metadata.runId },
    });
    await store.updateSocialOutreachDraft(draft.id, { status: "sent" });
    return {
      externalRef: sent.externalReplyId,
      status: sent.status,
      platform: sent.platform,
      executionMode: resolvePlatformActionExecutionMode({
        externalRef: sent.externalReplyId,
      }),
    };
  }

  const sent = await adapter.sendDm({
    companyId: draft.companyId,
    socialAccountId: account.id,
    externalAccountId: account.externalAccountId,
    externalContactId: contact.externalContactId,
    content: draft.message,
    metadata: { providerActionId: jobRun.id, runId: metadata.runId },
  });

  await store.updateSocialOutreachDraft(draft.id, { status: "sent" });

  return {
    externalRef: sent.externalMessageId,
    status: sent.status,
    platform: sent.platform,
    executionMode: resolvePlatformActionExecutionMode({
      externalRef: sent.externalMessageId,
    }),
  };
}

async function failJob(jobRun: JobRun, error: unknown): Promise<PlatformActionExecutionResult> {
  const detail = platformActionErrorDetail(error);
  const updated = await store.updateJobRun(jobRun.id, {
    status: "failed",
    completedAt: nowIso(),
    error: detail.message,
    resultCount: 0,
    metadata: {
      ...jobRun.metadata,
      error: detail.message,
      errorCode: detail.code,
      errorKind: detail.kind,
      recoverable: detail.recoverable,
      retryAfterSeconds: detail.retryAfterSeconds,
    },
  });
  return {
    status: "failed",
    jobRun: updated ?? jobRun,
    error: detail.message,
    errorCode: detail.code,
    errorKind: detail.kind,
    retryAfterSeconds: detail.retryAfterSeconds,
  };
}

function platformActionErrorDetail(error: unknown) {
  if (error instanceof Error) {
    const maybeProviderError = error as Error & { code?: string; retryAfterSeconds?: number };
    const code = typeof maybeProviderError.code === "string" ? maybeProviderError.code : undefined;
    const kind = platformActionErrorKind(code, error.message);
    return {
      message: error.message,
      code,
      kind,
      recoverable: platformActionErrorRecoverable(kind),
      retryAfterSeconds: typeof maybeProviderError.retryAfterSeconds === "number" ? maybeProviderError.retryAfterSeconds : undefined,
    };
  }
  const message = String(error);
  const kind = platformActionErrorKind(undefined, message);
  return { message, code: undefined, kind, recoverable: platformActionErrorRecoverable(kind), retryAfterSeconds: undefined };
}

function platformActionErrorKind(code: string | undefined, message: string): PlatformActionErrorKind {
  if (code === "needs_credentials") return "needs_credentials";
  if (code === "expired_token") return "expired_token";
  if (code === "rate_limited") return "rate_limited";
  if (code === "rejected_content" || code === "rejected_ad_creative") return "rejected_creative";
  if (code === "partial_publication") return "partial_publication";
  if (code === "unsupported_operation") return "unsupported_operation";
  if (/expired|invalid token|oauth/i.test(message)) return "expired_token";
  if (/rate limit|too many requests|retry-after/i.test(message)) return "rate_limited";
  if (/creative|content|policy|rejected/i.test(message)) return "rejected_creative";
  return "provider_error";
}

function platformActionErrorRecoverable(kind: PlatformActionErrorKind) {
  return kind === "needs_credentials" || kind === "expired_token" || kind === "rate_limited";
}

function comparableTime(primary?: string, fallback?: string) {
  return new Date(primary ?? fallback ?? 0).getTime();
}

function defaultSocialAdapter(platform: SocialPlatform): SocialPlatformAdapter {
  if (isPlatformActionLiveMode()) return getSocialPlatformAdapter(platform);
  return getSandboxSocialPlatformAdapter(platform);
}

function parsePlatformActionMetadata(metadata: Record<string, unknown>): PlatformActionMetadata | undefined {
  if (metadata.kind !== "agent_mission_platform_action") return undefined;
  if (typeof metadata.runId !== "string") return undefined;
  if (typeof metadata.approvalId !== "string") return undefined;
  if (typeof metadata.gate !== "string") return undefined;
  if (typeof metadata.action !== "string") return undefined;
  if (typeof metadata.platform !== "string") return undefined;
  if (typeof metadata.provider !== "string") return undefined;
  if (typeof metadata.targetId !== "string") return undefined;
  return metadata as PlatformActionMetadata;
}
