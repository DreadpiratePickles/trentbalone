import {
  buildContentMissionActionLedger,
  buildContentMissionApprovalPacket,
  type ContentMissionExternalActionKind,
} from "@/lib/content-mission";
import type { OrchestrationPlan, StepRecord } from "@/lib/orchestrator-runtime";
import type { PlatformAuthReadinessResult } from "@/lib/platform-auth-readiness";
import type { Approval } from "@/lib/types";

export type ContentMissionApprovalRequest = Omit<Approval, "id" | "status" | "createdAt">;

export type ContentMissionExternalActionGuardResult = {
  actionId: string;
  approval: Approval;
};

const ACTION_IDS: Record<Exclude<ContentMissionExternalActionKind, "platform_auth_or_scope_gap">, string> = {
  public_publish: "action_public_publish",
  comment_or_dm_reply: "action_comment_or_dm_reply",
  email_or_sales_send: "action_email_or_sales_send",
  paid_spend_or_boost: "action_paid_spend_or_boost",
};

const PLATFORM_READY_KINDS = new Set<ContentMissionExternalActionKind>([
  "public_publish",
  "comment_or_dm_reply",
  "paid_spend_or_boost",
]);

export function buildContentMissionApprovalRequests(input: {
  companyId: string;
  runId: string;
  plan: OrchestrationPlan;
  steps: StepRecord[];
}): ContentMissionApprovalRequest[] {
  const packet = buildContentMissionApprovalPacket(input.plan, input.steps);
  if (!packet) return [];
  return buildContentMissionActionLedger(input.plan, input.steps).map((item) => ({
    companyId: input.companyId,
    action: `content_mission.${item.kind}`,
    reason: item.reason,
    toolName: `content_mission:${input.runId}:${item.id}`,
    previewKind: "generic",
    previewContent: JSON.stringify({
      runId: input.runId,
      objective: input.plan.objective,
      item,
      packet,
    }, null, 2),
  }));
}

export function contentMissionActionToolName(input: {
  runId: string;
  kind: Exclude<ContentMissionExternalActionKind, "platform_auth_or_scope_gap">;
}): string {
  return `content_mission:${input.runId}:${ACTION_IDS[input.kind]}`;
}

export function assertContentMissionExternalActionAllowed(input: {
  companyId: string;
  runId: string;
  kind: ContentMissionExternalActionKind;
  approvals: Approval[];
  platformReadiness?: PlatformAuthReadinessResult | null;
}): ContentMissionExternalActionGuardResult {
  if (input.kind === "platform_auth_or_scope_gap") {
    throw new Error("Platform auth or scope gap is a blocker, not an executable external action.");
  }

  const actionId = ACTION_IDS[input.kind];
  const toolName = contentMissionActionToolName({ runId: input.runId, kind: input.kind });
  const approval = input.approvals.find((item) => {
    return item.companyId === input.companyId
      && item.status === "approved"
      && item.action === `content_mission.${input.kind}`
      && item.toolName === toolName;
  });

  if (!approval) {
    throw new Error(`External content mission action ${input.kind} requires an approved content mission approval for ${toolName}.`);
  }

  if (PLATFORM_READY_KINDS.has(input.kind)) {
    if (!input.platformReadiness) {
      throw new Error(`External content mission action ${input.kind} requires a platform readiness check before execution.`);
    }
    if (!input.platformReadiness.ready) {
      const details = input.platformReadiness.blockers.length
        ? input.platformReadiness.blockers.join("; ")
        : "platform readiness is not clean";
      throw new Error(`External content mission action ${input.kind} is blocked: ${details}.`);
    }
  }

  return { actionId, approval };
}
