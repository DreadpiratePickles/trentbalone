import { appendAuditLog } from "@/lib/audit-log";
import { labelSimulatedAction, platformActionExecutionMode, type PlatformActionExecutionMode } from "@/lib/platform-action-mode";
import { store } from "@/lib/store";

async function writeAgentMissionAudit(
  companyId: string,
  actor: "system" | "user" | "agent",
  action: string,
  objectType: string,
  objectId: string,
  summary: string,
): Promise<void> {
  if (process.env.DATABASE_URL?.trim()) {
    await appendAuditLog(companyId, actor, action, objectType, objectId, summary);
    return;
  }
  await store.addAudit(companyId, actor, action, objectType, objectId, summary);
}

export async function auditAgentMissionRunStarted(input: {
  companyId: string;
  runId: string;
  objective: string;
  budgetCents: number;
}): Promise<void> {
  await writeAgentMissionAudit(
    input.companyId,
    "agent",
    "agent_mission.run_started",
    "agent_mission_run",
    input.runId,
    `Agent mission started (${input.budgetCents}c budget): ${input.objective.slice(0, 160)}`,
  );
}

export async function auditAgentMissionApprovalRequested(input: {
  companyId: string;
  runId: string;
  approvalId: string;
  gate: string;
  action: string;
}): Promise<void> {
  await writeAgentMissionAudit(
    input.companyId,
    "agent",
    "agent_mission.approval_requested",
    "approval",
    input.approvalId,
    `Mission ${input.runId} requested approval for ${input.gate} (${input.action})`,
  );
}

export async function auditAgentMissionApprovalResolved(input: {
  companyId: string;
  runId: string;
  approvalId: string;
  gate: string;
  status: string;
}): Promise<void> {
  await writeAgentMissionAudit(
    input.companyId,
    "agent",
    "agent_mission.approval_resolved",
    "approval",
    input.approvalId,
    `Mission ${input.runId} approval ${input.gate} ${input.status}`,
  );
}

export async function auditAgentMissionPlatformAction(input: {
  companyId: string;
  runId: string;
  jobRunId: string;
  action: string;
  platform: string;
  status: "completed" | "failed" | "skipped";
  externalRef?: string;
  executionMode?: PlatformActionExecutionMode;
  error?: string;
}): Promise<void> {
  const mode = input.executionMode ?? platformActionExecutionMode();
  const base = `Mission ${input.runId} ${input.action} on ${input.platform} ${input.status}${input.externalRef ? ` (${input.externalRef})` : ""}${input.error ? `: ${input.error}` : ""}`;
  await writeAgentMissionAudit(
    input.companyId,
    "agent",
    `agent_mission.platform_action_${input.status}`,
    "job_run",
    input.jobRunId,
    labelSimulatedAction(base, mode),
  );
}
