import type {
  ContentMissionAction,
  ContentMissionExternalActionStatus,
  ContentMissionRunStatus,
} from "@/lib/types";

const EXECUTABLE_KINDS = new Set([
  "public_publish",
  "comment_or_dm_reply",
  "email_or_sales_send",
  "paid_spend_or_boost",
]);

function executableActions(actions: ContentMissionAction[]): ContentMissionAction[] {
  return actions.filter((a) => EXECUTABLE_KINDS.has(a.kind));
}

function hasPlatformAuthBlocker(actions: ContentMissionAction[]): boolean {
  return actions.some((a) => a.kind === "platform_auth_or_scope_gap");
}

export function deriveMissionExternalActionStatus(
  actions: ContentMissionAction[],
): ContentMissionExternalActionStatus {
  const executable = executableActions(actions);

  if (executable.length === 0) return "DRAFT_ONLY";

  const allExecuted = executable.every((a) => a.status === "executed");
  if (allExecuted) return "EXECUTED";

  const anyBlocked = executable.some((a) => a.status === "blocked");
  const hasPlatformBlocker = hasPlatformAuthBlocker(actions);
  if (anyBlocked || hasPlatformBlocker) return "BLOCKED";

  const someExecuted = executable.some((a) => a.status === "executed");
  const noneBlocked = executable.every((a) => a.status !== "blocked");
  if (someExecuted && noneBlocked) return "PARTIALLY_EXECUTED";

  return "DRAFT_READY";
}

export function deriveMissionRunStatus(
  actions: ContentMissionAction[],
): ContentMissionRunStatus | undefined {
  const externalStatus = deriveMissionExternalActionStatus(actions);

  if (externalStatus === "DRAFT_ONLY") return undefined;
  if (externalStatus === "BLOCKED") return "blocked";
  if (externalStatus === "EXECUTED") return "completed";

  const executable = executableActions(actions);
  const anyNeedsApproval = executable.some((a) => a.status === "needs_approval");
  if (anyNeedsApproval) return "awaiting_approval";

  return undefined;
}
