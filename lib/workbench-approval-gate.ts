import { store } from "@/lib/store";
import type { WorkbenchSession } from "@/lib/types";
import { requiresApproval } from "@/lib/workbench-safety";

export class WorkbenchApprovalRequiredError extends Error {
  readonly approvalId: string;
  readonly command: string;

  constructor(approvalId: string, command: string) {
    super(`Approval required before executing: ${command}`);
    this.name = "WorkbenchApprovalRequiredError";
    this.approvalId = approvalId;
    this.command = command;
  }
}

export function inferApprovalAction(command: string): string {
  const lower = command.trim().toLowerCase();
  if (lower.startsWith("git push")) return "git_push";
  if (lower.startsWith("git commit")) return "git_commit";
  if (lower.startsWith("npm publish") || lower.startsWith("yarn publish")) return "deploy";
  if (lower.includes("deploy") || lower.startsWith("vercel ") || lower.startsWith("fly ")) return "deploy";
  return "external_write";
}

export function isExternalWriteApprovalBlock(result: {
  blocked?: boolean;
  blockedReason?: string;
}): boolean {
  return Boolean(result.blocked && result.blockedReason === "external_write_requires_approval");
}

/** Pause the session and create a founder approval — does not execute the command. */
export async function pauseWorkbenchForCommandApproval(
  session: WorkbenchSession,
  command: string,
): Promise<string> {
  if (!requiresApproval(command)) {
    throw new Error(`Command does not require approval: ${command}`);
  }

  const action = inferApprovalAction(command);
  const approval = await store.createApproval({
    companyId: session.companyId,
    action: `workbench.${action}`,
    reason: `Workbench session requires approval before running: ${command}`,
    previewContent: command,
    previewKind: "generic",
    toolName: "workbench",
  });

  await store.updateWorkbenchSession(session.id, { status: "paused" });

  await store.addWorkbenchEvent({
    companyId: session.companyId,
    sessionId: session.id,
    type: "approval",
    status: "needs_approval",
    title: "Approval required",
    content: `Command blocked until approval: \`${command}\``,
    command,
    metadata: { approvalId: approval.id, gate: action },
  });

  return approval.id;
}
