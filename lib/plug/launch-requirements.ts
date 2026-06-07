import type { PlugDefinition } from "@/lib/plug/schema-v2";

export type PlugLaunchRequirementId =
  | "fixtures"
  | "run_logs"
  | "cost_estimate"
  | "approval_matrix"
  | "sample_output";

export type PlugLaunchRequirement = {
  id: PlugLaunchRequirementId;
  status: "passed" | "failed";
  detail: string;
};

export type PlugApprovalMatrixEntry = {
  toolId: string;
  allowedActions: string[];
  approvalRequiredActions: string[];
};

export type PlugLaunchEvidence = {
  runLogArtifactId?: string;
  sampleOutputArtifactId?: string;
};

export function evaluatePlugLaunchRequirements(
  plug: PlugDefinition,
  evidence: PlugLaunchEvidence,
) {
  const costEstimateCents = estimatePlugRunCostCents(plug);
  const approvalMatrix = buildPlugApprovalMatrix(plug);
  const requirements: PlugLaunchRequirement[] = [
    {
      id: "fixtures",
      status: plug.evalSet.fixtureRefs.length > 0 ? "passed" : "failed",
      detail: `${plug.evalSet.fixtureRefs.length} fixture${plug.evalSet.fixtureRefs.length === 1 ? "" : "s"}`,
    },
    {
      id: "run_logs",
      status: evidence.runLogArtifactId ? "passed" : "failed",
      detail: evidence.runLogArtifactId ?? "missing run log artifact",
    },
    {
      id: "cost_estimate",
      status: costEstimateCents > 0 ? "passed" : "failed",
      detail: `${costEstimateCents} cents estimated per run`,
    },
    {
      id: "approval_matrix",
      status: approvalMatrix.length > 0 ? "passed" : "failed",
      detail: `${approvalMatrix.length} tool approval entr${approvalMatrix.length === 1 ? "y" : "ies"}`,
    },
    {
      id: "sample_output",
      status: evidence.sampleOutputArtifactId ? "passed" : "failed",
      detail: evidence.sampleOutputArtifactId ?? "missing sample output artifact",
    },
  ];

  return {
    ready: requirements.every((requirement) => requirement.status === "passed"),
    costEstimateCents,
    approvalMatrix,
    requirements,
  };
}

export function estimatePlugRunCostCents(plug: PlugDefinition) {
  const seatBudgetCents = plug.seats.reduce((sum, seat) => sum + seat.budgetCents, 0);
  return Math.max(plug.costPerRunCents, seatBudgetCents);
}

export function buildPlugApprovalMatrix(plug: PlugDefinition): PlugApprovalMatrixEntry[] {
  return plug.declaredTools.map((tool) => ({
    toolId: tool.toolId,
    allowedActions: [...tool.allowedActions],
    approvalRequiredActions: [...tool.approvalRequiredActions],
  }));
}
