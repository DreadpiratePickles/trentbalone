import type { JobRun, JobRunStatus } from "@/lib/types";

export type MissionPlatformFailure = {
  jobRunId: string;
  action: string;
  provider: string;
  platform?: string;
  targetId: string;
  status: JobRunStatus;
  error: string;
  errorCode?: string;
  errorKind: string;
  recoverable: boolean;
  retryAfterSeconds?: number;
  nextAction: string;
};

export type MissionPlatformFailures = {
  summary: {
    total: number;
    recoverable: number;
    manualReview: number;
    rateLimited: number;
    expiredTokens: number;
  };
  failures: MissionPlatformFailure[];
};

export function buildMissionPlatformFailures(providerActions: JobRun[]): MissionPlatformFailures {
  const failures = providerActions
    .filter(isFailedProviderAction)
    .map(toMissionPlatformFailure);
  return {
    summary: {
      total: failures.length,
      recoverable: failures.filter((failure) => failure.recoverable).length,
      manualReview: failures.filter((failure) => !failure.recoverable).length,
      rateLimited: failures.filter((failure) => failure.errorKind === "rate_limited").length,
      expiredTokens: failures.filter((failure) => failure.errorKind === "expired_token").length,
    },
    failures,
  };
}

function isFailedProviderAction(job: JobRun) {
  return job.status === "failed" || Boolean(stringValue(job.metadata.error) || stringValue(job.metadata.errorKind));
}

function toMissionPlatformFailure(job: JobRun): MissionPlatformFailure {
  const errorKind = stringValue(job.metadata.errorKind) ?? inferErrorKind(job);
  const recoverable = booleanValue(job.metadata.recoverable) ?? defaultRecoverable(errorKind);
  const errorCode = stringValue(job.metadata.errorCode);
  const retryAfterSeconds = numberValue(job.metadata.retryAfterSeconds);
  return {
    jobRunId: job.id,
    action: stringValue(job.metadata.action) ?? job.summary,
    provider: stringValue(job.metadata.provider) ?? "provider",
    platform: stringValue(job.metadata.platform),
    targetId: stringValue(job.metadata.targetId) ?? job.id,
    status: job.status,
    error: stringValue(job.metadata.error) ?? job.error ?? job.summary,
    errorCode,
    errorKind,
    recoverable,
    retryAfterSeconds,
    nextAction: nextActionForPlatformFailure(errorKind, retryAfterSeconds),
  };
}

function inferErrorKind(job: JobRun) {
  const code = stringValue(job.metadata.errorCode);
  if (code === "expired_token") return "expired_token";
  if (code === "rate_limited") return "rate_limited";
  if (code === "rejected_ad_creative" || code === "rejected_creative") return "rejected_creative";
  if (code === "partial_publication") return "partial_publication";
  if (code === "needs_credentials") return "needs_credentials";
  return "provider_error";
}

function defaultRecoverable(errorKind: string) {
  return errorKind === "expired_token" || errorKind === "rate_limited" || errorKind === "needs_credentials";
}

function nextActionForPlatformFailure(errorKind: string, retryAfterSeconds?: number) {
  if (errorKind === "expired_token") {
    return "Refresh platform OAuth credentials, then retry the provider action.";
  }
  if (errorKind === "rate_limited") {
    return retryAfterSeconds
      ? `Wait ${retryAfterSeconds}s before retrying this provider action.`
      : "Wait for the provider rate limit window before retrying.";
  }
  if (errorKind === "rejected_creative") {
    return "Revise the creative/content and resubmit for approval before retrying.";
  }
  if (errorKind === "partial_publication") {
    return "Manually verify the provider state before retrying or reconciling the external ref.";
  }
  if (errorKind === "needs_credentials") {
    return "Connect the required platform account before retrying.";
  }
  return "Review provider logs and retry only after the blocker is understood.";
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function booleanValue(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
