import { store } from "@/lib/store";
import { resolveSupervisionApprovalExecution } from "@/lib/supervision/approval-execution";
import { syncContentMissionForApproval } from "@/lib/content-mission-approval-hook";
import { syncAgentMissionForApproval } from "@/lib/agent-mission-approval-hook";
import type { McpAuthContext, McpToolDefinition } from "./types";
import { approvalRunLink } from "./approval-links";

export const APPROVAL_TOOLS: McpToolDefinition[] = [
  {
    name: "trent_resolve_approval",
    description:
      "Approve or reject a pending Trent approval. This is intentionally hidden unless the key has the explicit mcp:approve scope.",
    inputSchema: {
      type: "object",
      properties: {
        approvalId: { type: "string", description: "Pending approval id." },
        decision: { type: "string", enum: ["approved", "rejected"], description: "Approval decision." },
        note: { type: "string", description: "Optional operator note for the external client." },
      },
      required: ["approvalId", "decision"],
      additionalProperties: false,
    },
    requiredScope: "mcp:approve",
    handler: resolveApprovalHandler,
  },
];

export async function resolveApprovalHandler(ctx: McpAuthContext, args: Record<string, unknown>): Promise<unknown> {
  const approvalId = typeof args.approvalId === "string" ? args.approvalId.trim() : "";
  if (!approvalId) throw new Error("approvalId is required");
  const decision = args.decision === "approved" || args.decision === "rejected" ? args.decision : undefined;
  if (!decision) throw new Error("decision must be approved or rejected");

  const existing = await store.getApproval(approvalId);
  if (!existing) throw new Error("approval not found");
  if (existing.companyId !== ctx.companyId) throw new Error("approval not found");
  const approval = await store.resolveApproval(approvalId, decision);
  if (!approval) throw new Error("approval not found");
  if (approval.taskId) {
    await store.updateTask(approval.taskId, {
      status: decision === "approved" ? "queued" : "blocked",
    });
  }
  await resolveSupervisionApprovalExecution({ approval, status: decision });
  await syncContentMissionForApproval(approval).catch(() => undefined);
  await syncAgentMissionForApproval(approval).catch(() => undefined);
  const link = approvalRunLink(approval);

  return {
    approval: {
      id: approval.id,
      status: approval.status,
      taskId: approval.taskId,
      action: approval.action,
      resolvedAt: approval.resolvedAt,
    },
    relatedRun: link.relatedRun,
    nextCall: link.nextCall,
  };
}
