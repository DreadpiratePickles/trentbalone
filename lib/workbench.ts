import { store } from "@/lib/store";
import type { AgentRole, WorkbenchAgentMode, WorkbenchProvider, WorkbenchSession, WorkbenchSessionMetadata } from "@/lib/types";
import { nowIso } from "@/lib/utils";
// Ensure all available providers are registered when this module is imported.
// `workbench-providers` self-registers mock_local synchronously and async-loads
// e2b / daytona when their API keys are present and SDKs are installed.
import { getDefaultWorkbenchProvider } from "@/lib/workbench-providers";
import { enqueueWorkbenchSession } from "@/lib/workbench-orchestrator";

export type WorkbenchCreateInput = {
  companyId: string;
  objective: string;
  taskId?: string;
  agentRole?: AgentRole;
  agentMode?: WorkbenchAgentMode;
  repoUrl?: string;
  provider?: WorkbenchProvider;
  allowedHosts?: string[];
  metadata?: Partial<WorkbenchSessionMetadata>;
  enqueue?: boolean;  // default true; false = return session in "queued" state without starting
};

export const DEFAULT_WORKBENCH_APPROVAL_GATES = [
  "workbench_plan",
  "external_form_submit",
  "login",
  "purchase",
  "download_private_data",
  "git_commit",
  "git_push",
  "pull_request_create",
  "deploy",
  "public_url_expose",
  "secret_access"
];

export function defaultWorkbenchMetadata(input?: {
  allowedHosts?: string[];
  metadata?: Partial<WorkbenchSessionMetadata>;
}): WorkbenchSession["metadata"] {
  const allowedHosts = uniqueHosts(input?.allowedHosts ?? []);
  return {
    networkPolicy: allowedHosts.length ? "allowlist" : "deny_all",
    allowedHosts,
    maxRuntimeSeconds: 30 * 60,
    maxCostCents: 250,
    approvalRequiredFor: DEFAULT_WORKBENCH_APPROVAL_GATES,
    rollbackAvailable: true,
    rollbackMode: "text_files_only",
    rollbackDescription: "Rollback can restore text files only from Workbench checkpoints; full filesystem/provider-native rollback is not yet proven.",
    ...(input?.metadata?.appSolo ? { appSolo: input.metadata.appSolo } : {}),
    ...(input?.metadata?.agentRun ? { agentRun: input.metadata.agentRun } : {})
  };
}

export function resolveWorkbenchSessionProvider(provider?: WorkbenchProvider): WorkbenchProvider {
  if (provider === "mock_local" && process.env.NODE_ENV === "production") {
    throw new Error("mock_local Workbench provider is dev/test only. Configure WORKBENCH_DEFAULT_PROVIDER=railway, daytona, or e2b in production.");
  }
  return provider ?? getDefaultWorkbenchProvider();
}

export async function createWorkbenchSession(input: WorkbenchCreateInput): Promise<WorkbenchSession> {
  const timestamp = nowIso();
  const provider = resolveWorkbenchSessionProvider(input.provider);
  const allowedHosts = uniqueHosts([
    ...(input.allowedHosts ?? []),
    ...hostsForRepoUrl(input.repoUrl),
  ]);
  const session = await store.createWorkbenchSession({
    companyId: input.companyId,
    taskId: input.taskId,
    agentRole: input.agentRole ?? "engineer",
    agentMode: input.agentMode ?? "build",
    provider,
    status: "queued",
    objective: input.objective,
    repoUrl: input.repoUrl,
    branchName: input.taskId ? `trent/${input.taskId}` : undefined,
    workdir: `/workspaces/${input.companyId}/${timestamp.slice(0, 10)}`,
    previewUrl: undefined,
    storageKey: `workbench/${input.companyId}/${timestamp}`,
    metadata: defaultWorkbenchMetadata({ allowedHosts, metadata: input.metadata })
  });

  await store.addWorkbenchEvent({
    companyId: session.companyId,
    sessionId: session.id,
    type: "system",
    status: "completed",
    title: "Workbench session created",
    content: "Trent reserved an isolated workspace with audit logging, approval gates, cost limits, and text-files-only rollback metadata."
  });

  await store.addWorkbenchEvent({
    companyId: session.companyId,
    sessionId: session.id,
    type: "plan",
    status: "pending",
    title: "Execution plan pending",
    content: "Next step: agent writes a short plan, then requests approval before repo writes, deploys, external submissions, purchases, or secret access."
  });

  if (input.enqueue !== false) {
    await enqueueWorkbenchSession(session.id);
    const refreshed = await store.getWorkbenchSession(session.id);
    if (!refreshed) throw new Error(`Session ${session.id} not found after enqueue`);
    return refreshed;
  }

  return session;
}

function hostsForRepoUrl(repoUrl?: string): string[] {
  if (!repoUrl?.trim()) return [];
  const trimmed = repoUrl.trim();
  try {
    const parsed = new URL(trimmed);
    return parsed.hostname ? [parsed.hostname.toLowerCase()] : [];
  } catch {
    const sshHost = trimmed.match(/^[\w.-]+@([^:/]+)[:/]/)?.[1];
    return sshHost ? [sshHost.toLowerCase()] : [];
  }
}

function uniqueHosts(hosts: string[]): string[] {
  return Array.from(new Set(
    hosts
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean)
  ));
}

export async function captureWorkbenchArtifact(input: {
  companyId: string;
  sessionId: string;
  title: string;
  kind?: Parameters<typeof store.addWorkbenchArtifact>[0]["kind"];
  mimeType?: string;
  sizeBytes?: number;
}) {
  const artifact = await store.addWorkbenchArtifact({
    companyId: input.companyId,
    sessionId: input.sessionId,
    kind: input.kind ?? "terminal_log",
    title: input.title,
    storageKey: `workbench/${input.sessionId}/${input.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    mimeType: input.mimeType ?? "text/plain",
    sizeBytes: input.sizeBytes ?? 0
  });

  await store.addWorkbenchEvent({
    companyId: input.companyId,
    sessionId: input.sessionId,
    type: "artifact",
    status: "completed",
    title: "Artifact captured",
    content: `${artifact.title} was attached to the workbench replay.`,
    artifactId: artifact.id
  });

  return artifact;
}
