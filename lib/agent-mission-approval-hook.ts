import { store } from "@/lib/store";
import { auditAgentMissionApprovalResolved } from "@/lib/agent-mission-audit";
import { executeApprovedAgentMissionAction } from "@/lib/agent-mission-executor";
import { refreshAgentMissionMemoryLog } from "@/lib/agent-mission-memory-log";
import { queueContentPerformanceFeedbackIngestion } from "@/lib/content/performance-feedback";
import { ingestMissionMemory } from "@/lib/gbrain/gbrain-memory";
import { executeQueuedPlatformAction } from "@/lib/platform-action-runner";
import {
  labelSimulatedAction,
  platformActionExecutionMode,
  resolvePlatformActionExecutionMode,
} from "@/lib/platform-action-mode";
import type { AgentMissionRun, Approval, Artifact, JobRun } from "@/lib/types";
import { nowIso } from "@/lib/utils";

export type AgentMissionApprovalRef = {
  runId: string;
  gate: string;
};

export function parseAgentMissionApprovalRef(approval: Approval): AgentMissionApprovalRef | undefined {
  if (!approval.toolName?.startsWith("agent_mission:")) return undefined;
  const [, runId, gate] = approval.toolName.split(":");
  if (!runId || !gate) return undefined;
  return { runId, gate };
}

export async function syncAgentMissionForApproval(
  approval: Approval,
): Promise<AgentMissionRun | undefined> {
  const ref = parseAgentMissionApprovalRef(approval);
  if (!ref) return undefined;

  const run = await store.getAgentMissionRun(ref.runId);
  if (!run) return undefined;

  await appendApprovalEventOnce(run, {
    kind: "approval_resolved",
    payload: {
      approvalId: approval.id,
      gate: ref.gate,
      status: approval.status,
      action: approval.action,
    },
  });
  await auditAgentMissionApprovalResolved({
    companyId: run.companyId,
    runId: run.id,
    approvalId: approval.id,
    gate: ref.gate,
    status: approval.status,
  });

  let blockedExecution: string | undefined;
  if (approval.status === "approved") {
    const execution = await executeApprovedAgentMissionAction({ run, approval, gate: ref.gate });
    const artifact = await createApprovalExecutionArtifact(run, approval, ref, execution);
    await appendApprovalEventOnce(run, {
      kind: "artifact_created",
      payload: {
        artifactId: artifact.id,
        approvalId: approval.id,
        gate: ref.gate,
        externalActionStatus: execution.status,
        externalRef: execution.externalRef,
      },
    });
    if (execution.providerActionId && shouldAutoExecuteProviderAction(ref.gate)) {
      const existingJob = await store.getJobRun(execution.providerActionId);
      if (existingJob?.status !== "completed") {
        const providerResult = await executeQueuedPlatformAction(execution.providerActionId);
        await store.appendAgentMissionEvent({
          runId: run.id,
          companyId: run.companyId,
          kind: "provider_action_executed",
          payload: {
            providerActionId: execution.providerActionId,
            approvalId: approval.id,
            gate: ref.gate,
            status: providerResult.status,
            externalRef: providerResult.externalRef,
            error: providerResult.error,
            errorCode: providerResult.errorCode,
            errorKind: providerResult.errorKind,
            retryAfterSeconds: providerResult.retryAfterSeconds,
          },
        });
        if (providerResult.status === "failed") {
          blockedExecution = `Provider action failed: ${providerResult.error ?? "unknown error"}`;
        }
      }
    }
    if (execution.status === "blocked") blockedExecution = execution.artifactContent;
  }

  const approvals = (await store.listApprovals(run.companyId))
    .filter((item) => item.toolName?.startsWith(`agent_mission:${run.id}:`));
  const rejected = approvals.find((item) => item.status === "rejected");
  if (rejected) {
    return updateRunAndRefreshMemoryLog(run.id, {
      status: "failed",
      finalSummary: appendUniqueLine(run.finalSummary, `Rejected approval: ${rejected.action} (${rejected.id})`),
      completedAt: nowIso(),
    }, approval, ref);
  }
  if (blockedExecution) {
    return updateRunAndRefreshMemoryLog(run.id, {
      status: "failed",
      finalSummary: appendUniqueLine(run.finalSummary, `Blocked approved AgentMission action:\n${blockedExecution}`),
      completedAt: nowIso(),
    }, approval, ref);
  }
  const allApproved = approvals.length > 0 && approvals.every((item) => item.status === "approved");
  if (allApproved) {
    const feedbackJob = await queueMissionPerformanceFeedbackOnce(run);
    const executedSummary = await buildExecutedExternalActionSummary(run);
    return updateRunAndRefreshMemoryLog(run.id, {
      status: "completed",
      finalSummary: appendUniqueLine(
        appendUniqueLine(
          appendUniqueLine(
            appendUniqueLine(run.finalSummary, executedSummary),
            feedbackJob
              ? `Content performance feedback queued: ${feedbackJob.id}`
              : "Content performance feedback queue could not be started; see mission trace.",
          ),
          "All AgentMission approval-gated external actions were approved and recorded.",
        ),
        platformActionExecutionMode() === "sandbox"
          ? "Platform actions ran in sandbox mode — no live posts, replies, or ad spend were sent."
          : "Platform actions ran in live mode.",
      ),
      completedAt: nowIso(),
    }, approval, ref);
  }
  return updateRunAndRefreshMemoryLog(run.id, { status: "awaiting_approval" }, approval, ref);
}

async function queueMissionPerformanceFeedbackOnce(run: AgentMissionRun): Promise<JobRun | undefined> {
  try {
    const existing = await findMissionPerformanceFeedbackJob(run);
    if (existing) {
      await appendMissionEventOnce(run, {
        kind: "content_performance_feedback_queued",
        payload: {
          missionRunId: run.id,
          jobRunId: existing.id,
          status: existing.status,
          reused: true,
        },
        identity: `content_performance_feedback_queued:${run.id}`,
      });
      return existing;
    }

    const job = await queueContentPerformanceFeedbackIngestion({
      companyId: run.companyId,
      missionRunId: run.id,
      trigger: "system",
    });
    await appendMissionEventOnce(run, {
      kind: "content_performance_feedback_queued",
      payload: {
        missionRunId: run.id,
        jobRunId: job.id,
        status: job.status,
        reused: false,
      },
      identity: `content_performance_feedback_queued:${run.id}`,
    });
    return job;
  } catch (error) {
    await appendMissionEventOnce(run, {
      kind: "content_performance_feedback_queue_failed",
      payload: {
        missionRunId: run.id,
        error: errorMessage(error),
      },
      identity: `content_performance_feedback_queue_failed:${run.id}`,
    });
    return undefined;
  }
}

async function findMissionPerformanceFeedbackJob(run: AgentMissionRun): Promise<JobRun | undefined> {
  return (await store.listJobRuns(run.companyId)).find((job) =>
    job.type === "content_performance_ingest"
    && job.metadata.kind === "content_performance_feedback"
    && job.metadata.missionRunId === run.id
  );
}

async function updateRunAndRefreshMemoryLog(
  runId: string,
  patch: Partial<AgentMissionRun>,
  approval: Approval,
  ref: AgentMissionApprovalRef,
): Promise<AgentMissionRun | undefined> {
  const updated = await store.updateAgentMissionRun(runId, patch);
  if (updated) {
    const refreshed = await refreshAgentMissionMemoryLog(updated);
    if (refreshed) {
      const ingest = await ingestMissionMemory({
        companyId: updated.companyId,
        runId: updated.id,
        objective: updated.objective,
        markdown: refreshed.markdown,
        documentId: refreshed.document.id,
      });
      await appendApprovalEventOnce(updated, {
        kind: "memory_ingested",
        payload: {
          approvalId: approval.id,
          gate: ref.gate,
          refreshed: true,
          status: ingest.status,
          source: ingest.source,
          documentId: ingest.documentId ?? refreshed.document.id,
        },
      });
    }
  }
  return updated;
}

async function createApprovalExecutionArtifact(
  run: AgentMissionRun,
  approval: Approval,
  ref: AgentMissionApprovalRef,
  execution: Awaited<ReturnType<typeof executeApprovedAgentMissionAction>>,
): Promise<Artifact> {
  const existing = (await store.listArtifacts(run.companyId)).find((artifact) =>
    artifact.storageKey === `agent-missions/${run.id}/approvals/${approval.id}.md`
  );
  if (existing) return existing;

  const content = [
    "# AgentMission Approved External Action",
    "",
    `- runId: ${run.id}`,
    `- objective: ${run.objective}`,
    `- approvalId: ${approval.id}`,
    `- action: ${approval.action}`,
    `- gate: ${ref.gate}`,
    `- status: ${approval.status}`,
    `- resolvedAt: ${approval.resolvedAt ?? nowIso()}`,
    "",
    execution.artifactContent,
  ].join("\n");

  return store.createArtifact({
    companyId: run.companyId,
    type: "campaign_report",
    status: execution.artifactStatus,
    title: execution.artifactTitle,
    summary: `${execution.status} ${approval.action} for mission ${run.id}`,
    content,
    exportFormat: "markdown",
    storageKey: `agent-missions/${run.id}/approvals/${approval.id}.md`,
    createdByAgent: "ceo",
    provenance: {
      prompt: run.objective,
      sources: [run.id, approval.id],
      model: "approval-resolution-hook",
      tokens: 0,
      costCents: 0,
      generatedAt: nowIso(),
    },
    approvalStatus: approval.status,
  });
}

async function appendApprovalEventOnce(
  run: AgentMissionRun,
  event: {
    kind: string;
    payload: Record<string, unknown> & { approvalId: string; gate: string };
  },
) {
  const existing = (await store.listAgentMissionEvents(run.id)).find((item) =>
    item.kind === event.kind
    && item.payload.approvalId === event.payload.approvalId
    && item.payload.gate === event.payload.gate
  );
  if (existing) return existing;
  return store.appendAgentMissionEvent({
    runId: run.id,
    companyId: run.companyId,
    kind: event.kind,
    payload: event.payload,
  });
}

async function appendMissionEventOnce(
  run: AgentMissionRun,
  event: {
    kind: string;
    payload: Record<string, unknown>;
    identity: string;
  },
) {
  const existing = (await store.listAgentMissionEvents(run.id)).find((item) =>
    item.kind === event.kind && item.payload.identity === event.identity
  );
  if (existing) return existing;
  return store.appendAgentMissionEvent({
    runId: run.id,
    companyId: run.companyId,
    kind: event.kind,
    payload: { ...event.payload, identity: event.identity },
  });
}

function appendLine(value: string | undefined, line: string): string {
  return [value?.trim(), line].filter(Boolean).join("\n\n");
}

function appendUniqueLine(value: string | undefined, line: string): string {
  return value?.includes(line) ? value : appendLine(value, line);
}

function shouldAutoExecuteProviderAction(gate: string) {
  return gate === "public_publish"
    || gate === "paid_spend_or_boost"
    || gate === "comment_or_dm_reply"
    || gate === "email_or_sales_send";
}

async function buildExecutedExternalActionSummary(run: AgentMissionRun): Promise<string> {
  const jobs = (await store.listJobRuns(run.companyId))
    .filter((job) =>
      job.type === "platform_action"
      && job.metadata.kind === "agent_mission_platform_action"
      && job.metadata.runId === run.id
      && job.status === "completed"
    )
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  if (jobs.length === 0) {
    return [
      "## Executed External Actions",
      "",
      "- No provider actions executed yet.",
    ].join("\n");
  }
  return [
    "## Executed External Actions",
    "",
    ...jobs.map(formatExecutedProviderAction),
  ].join("\n");
}

function formatExecutedProviderAction(job: JobRun): string {
  const result = recordValue(job.metadata.result);
  const action = stringValue(job.metadata.action) ?? "unknown_action";
  const provider = stringValue(job.metadata.provider) ?? "unknown_provider";
  const status = stringValue(result?.status) ?? job.status;
  const externalRef = stringValue(result?.externalRef) ?? stringValue(job.metadata.targetId) ?? job.id;
  const executionMode = resolvePlatformActionExecutionMode({
    executionMode: job.metadata.executionMode ?? result?.executionMode,
    externalRef,
  });
  return labelSimulatedAction(
    `- ${action} via ${provider}: ${status} (${externalRef})`,
    executionMode,
  );
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
