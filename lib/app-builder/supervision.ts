import type { Approval } from "@/lib/types";

export type AppBuilderReleaseTarget = "pr" | "deploy";

export type AppBuilderReleasePlanCard = {
  runId: string;
  target: AppBuilderReleaseTarget;
  approvalAction: "app_builder_pr" | "app_builder_deploy";
  previewUrl?: string;
  estimatedCostCents: number;
  rollbackTarget?: string;
  riskClass: "reversible" | "costly";
  reversibility: "rollback_available" | "manual_revert";
};

export type ReleaseApprovalStore = {
  createApproval(input: Omit<Approval, "id" | "status" | "createdAt">): Promise<Approval>;
};

export function createReleasePlanCard(input: {
  runId: string;
  target: AppBuilderReleaseTarget;
  estimatedCostCents: number;
  previewUrl?: string;
  rollbackTarget?: string;
}): AppBuilderReleasePlanCard {
  return {
    runId: input.runId,
    target: input.target,
    approvalAction: input.target === "pr" ? "app_builder_pr" : "app_builder_deploy",
    previewUrl: input.previewUrl,
    estimatedCostCents: input.estimatedCostCents,
    rollbackTarget: input.rollbackTarget,
    riskClass: input.target === "deploy" ? "costly" : "reversible",
    reversibility: input.rollbackTarget ? "rollback_available" : "manual_revert",
  };
}

export async function createReleaseApproval(input: {
  store: ReleaseApprovalStore;
  companyId: string;
  card: AppBuilderReleasePlanCard;
}) {
  return input.store.createApproval({
    companyId: input.companyId,
    action: input.card.approvalAction,
    reason: `Approve app-builder ${input.card.target} for run ${input.card.runId}`,
    toolName: "app_builder",
    previewKind: input.card.target === "pr" ? "diff" : "generic",
    previewContent: formatPlanCard(input.card),
  });
}

function formatPlanCard(card: AppBuilderReleasePlanCard) {
  return [
    `Run: ${card.runId}`,
    `Target: ${card.target}`,
    `Preview: ${card.previewUrl ?? "not available"}`,
    `Estimated cost: ${card.estimatedCostCents} cents`,
    `Risk: ${card.riskClass}`,
    `Reversibility: ${card.reversibility}`,
    `Rollback target: ${card.rollbackTarget ?? "manual revert"}`,
  ].join("\n");
}
