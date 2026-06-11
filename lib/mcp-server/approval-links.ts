import type { Approval } from "@/lib/types";

export type McpApprovalRelatedRun = {
  kind: "workbench" | "orchestration";
  runId: string;
  gate?: string;
};

export function approvalRunLink(approval: Pick<Approval, "toolName">): {
  relatedRun?: McpApprovalRelatedRun;
  nextCall?: { tool: "trent_get_run"; arguments: { runId: string } };
} {
  const relatedRun = relatedRunForApproval(approval);
  if (!relatedRun) return {};
  return {
    relatedRun,
    nextCall: {
      tool: "trent_get_run",
      arguments: { runId: relatedRun.runId },
    },
  };
}

function relatedRunForApproval(approval: Pick<Approval, "toolName">): McpApprovalRelatedRun | undefined {
  const parts = approval.toolName?.split(":") ?? [];
  const [kind, runId, ...gateParts] = parts;
  if ((kind !== "workbench" && kind !== "orchestration") || !runId) return undefined;
  const gate = gateParts.join(":") || undefined;
  return { kind, runId, gate };
}
