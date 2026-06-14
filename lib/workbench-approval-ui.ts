import type { Approval } from "@/lib/types";

export type WorkbenchApprovalSummary = Pick<
  Approval,
  "id" | "action" | "status" | "reason" | "toolName" | "previewContent" | "previewKind"
>;

export function findPendingWorkbenchPlanApproval(
  sessionId: string | undefined | null,
  approvals: WorkbenchApprovalSummary[],
): WorkbenchApprovalSummary | undefined {
  if (!sessionId) return undefined;
  const toolName = `workbench:${sessionId}:plan`;
  return approvals.find((approval) =>
    approval.status === "pending"
    && approval.action === "workbench.plan"
    && approval.toolName === toolName,
  );
}
