import {
  isSandboxExternalRef,
  labelSimulatedAction,
  platformActionModeLabel,
  resolvePlatformActionExecutionMode,
  type PlatformActionExecutionMode,
} from "@/lib/platform-action-mode";
import type { JobRun } from "@/lib/types";

export function resolveMissionExecutionMode(input: {
  executionMode?: unknown;
  externalRef?: string | null;
  metadata?: Record<string, unknown>;
}): PlatformActionExecutionMode {
  const providerAction = input.metadata?.providerAction;
  const metadataMode = input.metadata?.executionMode
    ?? (providerAction && typeof providerAction === "object"
      ? (providerAction as Record<string, unknown>).executionMode
      : undefined);
  return resolvePlatformActionExecutionMode({
    executionMode: input.executionMode ?? metadataMode,
    externalRef: input.externalRef,
  });
}

export function formatProviderActionLabel(action: Pick<JobRun, "id" | "status" | "summary" | "metadata">): string {
  const metadata = action.metadata;
  const platformAction = typeof metadata.action === "string" ? metadata.action : action.summary;
  const provider = typeof metadata.provider === "string" ? metadata.provider : "provider";
  const targetId = typeof metadata.targetId === "string" ? metadata.targetId : action.id;
  const result = metadata.result && typeof metadata.result === "object"
    ? metadata.result as Record<string, unknown>
    : undefined;
  const executionMode = resolvePlatformActionExecutionMode({
    executionMode: metadata.executionMode ?? result?.executionMode,
    externalRef: typeof result?.externalRef === "string" ? result.externalRef : undefined,
  });
  const base = `${action.id} / ${action.status} / ${platformAction} / ${provider} / ${targetId}`;
  return labelSimulatedAction(base, executionMode);
}

export function formatSocialPostStatusLabel(input: {
  status: string;
  externalPostId?: string | null;
  metadata?: Record<string, unknown>;
}): string {
  const mode = resolveMissionExecutionMode({
    externalRef: input.externalPostId,
    metadata: input.metadata,
  });
  if (mode === "sandbox" && input.status === "published") {
    return `${input.status} (${platformActionModeLabel(mode)})`;
  }
  if (isSandboxExternalRef(input.externalPostId)) {
    return `${input.status} (${platformActionModeLabel("sandbox")})`;
  }
  return input.status;
}

export function sandboxBadgeText(mode: PlatformActionExecutionMode): string | undefined {
  return mode === "sandbox" ? platformActionModeLabel(mode) : undefined;
}
