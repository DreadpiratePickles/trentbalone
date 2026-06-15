import { createHash } from "node:crypto";
import { getCompanyAutonomySettings } from "@/lib/autonomy-settings";
import { store } from "@/lib/store";
import type { Approval, WorkbenchSession } from "@/lib/types";
import type { ArtifactAction } from "@/lib/workbench-artifact-parser";
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

export function summarizeWorkbenchPlanActions(actions: ArtifactAction[]): string {
  return actions.map((action, index) => {
    const prefix = `${index + 1}.`;
    if (action.type === "file") return `${prefix} write ${action.filePath}`;
    if (action.type === "edit") return `${prefix} edit ${action.filePath}`;
    if (action.type === "shell") return `${prefix} run ${action.command}`;
    return `${prefix} start ${action.command}`;
  }).join("\n");
}

export function fingerprintWorkbenchPlan(actions: ArtifactAction[]): string {
  const normalized = actions.map((action) => {
    if (action.type === "file") return { type: action.type, filePath: action.filePath, contentHash: createHash("sha256").update(action.content).digest("hex") };
    if (action.type === "edit") return { type: action.type, filePath: action.filePath, patchHash: createHash("sha256").update(action.content).digest("hex") };
    return { type: action.type, command: action.command };
  });
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 16);
}

function hasWorkbenchPlanGate(session: WorkbenchSession): boolean {
  return session.metadata.approvalRequiredFor.some(isWorkbenchPlanGate);
}

function isWorkbenchPlanGate(gate: string): boolean {
  return gate === "workbench_plan" || gate === "workbench.plan" || gate === "plan";
}

export async function shouldRequireWorkbenchPlanApproval(session: WorkbenchSession): Promise<boolean> {
  if (!hasWorkbenchPlanGate(session)) return false;
  const company = await store.getCompany(session.companyId).catch(() => undefined);
  if (company && getCompanyAutonomySettings(company).mode === "autonomous") return false;
  return true;
}

export function workbenchSessionIdFromPlanApproval(
  approval: Pick<Approval, "action" | "toolName">,
): string | undefined {
  if (approval.action !== "workbench.plan") return undefined;
  const match = approval.toolName?.match(/^workbench:([^:]+):plan$/);
  return match?.[1];
}

export async function clearWorkbenchPlanGateForApproval(
  approval: Pick<Approval, "action" | "toolName">,
): Promise<void> {
  const sessionId = workbenchSessionIdFromPlanApproval(approval);
  if (!sessionId) return;
  const session = await store.getWorkbenchSession(sessionId);
  if (!session) return;
  const approvalRequiredFor = session.metadata.approvalRequiredFor.filter((gate) => !isWorkbenchPlanGate(gate));
  if (approvalRequiredFor.length === session.metadata.approvalRequiredFor.length) return;
  await store.updateWorkbenchSession(sessionId, {
    metadata: {
      ...session.metadata,
      approvalRequiredFor,
    },
  });
}

export async function ensureWorkbenchPlanApproval(
  session: WorkbenchSession,
  title: string,
  actions: ArtifactAction[],
): Promise<{ approved: boolean; approvalId: string; fingerprint: string; rejected?: boolean }> {
  const fingerprint = fingerprintWorkbenchPlan(actions);
  const toolName = `workbench:${session.id}:plan`;
  const fingerprintLine = `Plan fingerprint: ${fingerprint}`;
  const existing = (await store.listApprovals(session.companyId)).find((approval) =>
    approval.action === "workbench.plan"
    && approval.toolName === toolName
    && approval.previewContent?.includes(fingerprintLine)
  );

  if (existing?.status === "approved") {
    return { approved: true, approvalId: existing.id, fingerprint };
  }
  if (existing?.status === "pending") {
    await store.updateWorkbenchSession(session.id, { status: "paused" });
    return { approved: false, approvalId: existing.id, fingerprint };
  }
  if (existing?.status === "rejected") {
    await store.updateWorkbenchSession(session.id, { status: "paused" });
    return { approved: false, approvalId: existing.id, fingerprint, rejected: true };
  }

  const approval = await store.createApproval({
    companyId: session.companyId,
    action: "workbench.plan",
    reason: `Approve Workbench implementation plan before file writes for session ${session.id}.`,
    previewContent: [
      fingerprintLine,
      `Title: ${title}`,
      "",
      "Planned actions:",
      summarizeWorkbenchPlanActions(actions),
    ].join("\n"),
    previewKind: "generic",
    toolName,
  });

  await store.updateWorkbenchSession(session.id, { status: "paused" });
  await store.addWorkbenchEvent({
    companyId: session.companyId,
    sessionId: session.id,
    type: "approval",
    status: "needs_approval",
    title: "Plan approval required",
    content: `Workbench paused before file writes. Approve plan ${fingerprint} to continue.`,
    metadata: { approvalId: approval.id, gate: "plan", fingerprint },
  });

  return { approved: false, approvalId: approval.id, fingerprint };
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
    toolName: `workbench:${session.id}:${action}`,
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
