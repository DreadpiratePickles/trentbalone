import type { AgentRole } from "@/lib/types";

export type AgentMissionType =
  | "content_social_ads"
  | "research"
  | "sales"
  | "support"
  | "custom";

export type AgentMissionStatus =
  | "planning"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export type AgentMissionTrigger = "manual" | "command" | "scheduled" | "delegated";

export type AgentMissionStepStatus =
  | "pending"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "blocked"
  | "skipped";

export type AgentMissionEventKind =
  | "run_start"
  | "plan_ready"
  | "step_start"
  | "step_output"
  | "step_blocked"
  | "step_awaiting_approval"
  | "step_end"
  | "approval_requested"
  | "approval_resolved"
  | "artifact_created"
  | "run_done"
  | "run_failed"
  | string;

export type AgentMissionRun = {
  id: string;
  companyId: string;
  objective: string;
  missionType: AgentMissionType;
  status: AgentMissionStatus;
  trigger: AgentMissionTrigger;
  ownerSeat: AgentRole | string;
  budgetCents: number;
  costCents: number;
  approvalPolicy: Record<string, unknown>;
  modelPolicy: Record<string, unknown>;
  finalSummary?: string;
  startedAt: string;
  completedAt?: string;
  updatedAt: string;
};

export type AgentMissionStep = {
  id: string;
  runId: string;
  companyId: string;
  seq: number;
  agentRole: AgentRole | string;
  title: string;
  objective: string;
  status: AgentMissionStepStatus;
  dependsOn: string[];
  expectedOutput: string;
  output?: string;
  toolCalls?: Record<string, unknown>[];
  costCents: number;
  approvalId?: string;
  startedAt?: string;
  completedAt?: string;
};

export type AgentMissionEvent = {
  id: string;
  runId: string;
  companyId: string;
  stepId?: string;
  seq: number;
  kind: AgentMissionEventKind;
  payload: Record<string, unknown>;
  createdAt: string;
};
