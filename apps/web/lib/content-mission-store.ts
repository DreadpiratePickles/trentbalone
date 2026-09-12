import { store } from "@/lib/store";
import { nowIso } from "@/lib/utils";
import {
  buildContentMissionActionLedger,
  buildContentMissionDossier,
} from "@/lib/content-mission";
import {
  deriveMissionExternalActionStatus,
  deriveMissionRunStatus,
} from "@/lib/content-mission-status";
import type { OrchestrationPlan, StepRecord } from "@/lib/orchestrator-runtime";
import type {
  Approval,
  ContentMissionAction,
  ContentMissionActionStatus,
  ContentMissionRun,
  ContentMissionRunStatus,
} from "@/lib/types";

export async function recordContentMissionRun(input: {
  companyId: string;
  runId: string;
  cycleId?: string;
  plan: OrchestrationPlan;
  steps: StepRecord[];
  budgetCents?: number;
  status?: ContentMissionRunStatus;
}): Promise<ContentMissionRun | null> {
  const dossier = buildContentMissionDossier(input.plan.objective);
  if (!dossier) return null;

  const ledger = buildContentMissionActionLedger(input.plan, input.steps);

  // Build provisional action shapes for derivation before persisting
  const provisionalActions: ContentMissionAction[] = ledger.map((item) => ({
    id: `${input.runId}:${item.id}`,
    runId: input.runId,
    companyId: input.companyId,
    ledgerItemId: item.id,
    kind: item.kind,
    owner: item.owner,
    status: item.status,
    approvalGate: item.approvalGate,
    sourceStage: item.sourceStage,
    reason: item.reason,
    relatedPlatforms: item.relatedPlatforms,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }));
  const externalActionStatus = deriveMissionExternalActionStatus(provisionalActions);

  const run = await store.createContentMissionRun({
    id: input.runId,
    companyId: input.companyId,
    runId: input.runId,
    cycleId: input.cycleId,
    objective: input.plan.objective,
    operatingMode: dossier.operatingMode,
    status: input.status ?? "planning",
    ownerSeat: "ceo",
    externalActionStatus,
    requiredSocialPlatforms: dossier.requiredSocialPlatforms,
    requiredMarketingPlatforms: dossier.requiredMarketingPlatforms,
    socialPublishingRequested: dossier.socialPublishingRequested,
    paidAdsRequested: dossier.paidAdsRequested,
    approvalGates: dossier.approvalGates,
    memoryLogFields: dossier.memoryLogFields,
    creativeApps: dossier.creativeApps,
    budgetCents: input.budgetCents ?? 0,
    costCents: 0,
  });

  for (const action of provisionalActions) {
    await store.upsertContentMissionAction(action);
  }

  return run;
}

export async function syncContentMissionActionApprovals(input: {
  runId: string;
  approvals: Approval[];
}): Promise<ContentMissionAction[]> {
  const actions = await store.listContentMissionActions(input.runId);
  const updated: ContentMissionAction[] = [];

  for (const action of actions) {
    if (action.kind === "platform_auth_or_scope_gap") {
      updated.push(action);
      continue;
    }
    const toolName = `content_mission:${input.runId}:${action.ledgerItemId}`;
    const approval = input.approvals.find(
      (item) => item.toolName === toolName && item.action === `content_mission.${action.kind}`,
    );
    if (!approval) {
      updated.push(action);
      continue;
    }
    const status: ContentMissionActionStatus =
      approval.status === "approved"
        ? "approved"
        : approval.status === "rejected"
          ? "rejected"
          : "needs_approval";
    updated.push(
      await store.upsertContentMissionAction({ ...action, approvalId: approval.id, status }),
    );
  }

  // Recompute run status from the updated ledger
  const externalActionStatus = deriveMissionExternalActionStatus(updated);
  const derivedStatus = deriveMissionRunStatus(updated);
  await store.updateContentMissionRun(input.runId, {
    externalActionStatus,
    ...(derivedStatus ? { status: derivedStatus } : {}),
  });

  return updated;
}

export async function finalizeContentMissionRun(input: {
  runId: string;
  status: ContentMissionRunStatus;
  summary?: string;
  costCents?: number;
  memoryLogArtifactId?: string;
}): Promise<ContentMissionRun | undefined> {
  return store.updateContentMissionRun(input.runId, {
    status: input.status,
    summary: input.summary,
    costCents: input.costCents,
    memoryLogArtifactId: input.memoryLogArtifactId,
    completedAt: nowIso(),
  });
}

export async function markContentMissionActionExecuted(input: {
  runId: string;
  kind: ContentMissionAction["kind"];
  externalRef?: string;
}): Promise<ContentMissionRun | undefined> {
  const actions = await store.listContentMissionActions(input.runId);
  const action = actions.find((a) => a.kind === input.kind);
  if (!action) return undefined;

  const reason = input.externalRef
    ? `${action.reason} (executed: ${input.externalRef})`
    : action.reason;
  const updated = await store.upsertContentMissionAction({
    ...action,
    status: "executed",
    reason,
  });
  const next = actions.map((a) => (a.id === updated.id ? updated : a));
  const externalActionStatus = deriveMissionExternalActionStatus(next);
  const derivedStatus = deriveMissionRunStatus(next);
  return store.updateContentMissionRun(input.runId, {
    externalActionStatus,
    ...(derivedStatus ? { status: derivedStatus } : {}),
  });
}
