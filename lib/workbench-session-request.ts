import type { WorkbenchAgentMode, WorkbenchProvider, WorkbenchSessionMetadata } from "@/lib/types";

export type WorkbenchCreateRequestInput = {
  companyId: string;
  objective: string;
  agentMode?: WorkbenchAgentMode;
  agentRole?: string;
  taskId?: string;
  repoUrl?: string;
  provider?: WorkbenchProvider;
  allowedHosts?: string[];
  metadata?: Partial<WorkbenchSessionMetadata>;
};

export function buildWorkbenchCreateRequestBody(input: WorkbenchCreateRequestInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    companyId: input.companyId,
    objective: input.objective,
  };
  if (input.agentMode) body.agentMode = input.agentMode;
  if (input.agentRole) body.agentRole = input.agentRole;
  if (input.taskId) body.taskId = input.taskId;
  if (input.repoUrl) body.repoUrl = input.repoUrl;
  if (input.provider) body.provider = input.provider;
  if (input.allowedHosts?.length) body.allowedHosts = input.allowedHosts;
  if (input.metadata) body.metadata = input.metadata;
  return body;
}
