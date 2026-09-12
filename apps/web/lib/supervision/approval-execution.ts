import { enqueueSubtaskRun } from "@/lib/queue";
import { store } from "@/lib/store";
import type { Approval } from "@/lib/types";
import { nowIso } from "@/lib/utils";
import { subtaskSchema, type Subtask } from "@/lib/planner";

type EnqueueSubtaskRun = typeof enqueueSubtaskRun;

export async function resolveSupervisionApprovalExecution(input: {
  approval: Approval;
  status: "approved" | "rejected";
  enqueueSubtaskRun?: EnqueueSubtaskRun;
}) {
  const jobs = await store.listJobRuns(input.approval.companyId);
  const linkedActions = jobs.filter((job) =>
    job.type === "supervision_action"
    && job.status === "running"
    && job.metadata.kind === "action_queue"
    && job.metadata.approvalId === input.approval.id
  );

  let executed = 0;
  let replanned = 0;
  const enqueue = input.enqueueSubtaskRun ?? enqueueSubtaskRun;

  for (const job of linkedActions) {
    if (input.status === "approved") {
      const subtask = parseSubtask(job.metadata.payload);
      if (!subtask) continue;
      const executionJob = await enqueue({
        companyId: input.approval.companyId,
        subtask,
        trigger: "system",
      });
      await store.updateJobRun(job.id, {
        status: "completed",
        completedAt: nowIso(),
        resultCount: 1,
        summary: `Approval executed: ${input.approval.action}`,
        metadata: {
          ...job.metadata,
          executionJobRunId: executionJob.id,
          executedAt: nowIso(),
        },
      });
      await store.addAudit(
        input.approval.companyId,
        "agent",
        "supervision.approval.executed",
        "approval",
        input.approval.id,
        input.approval.action,
      );
      executed += 1;
      continue;
    }

    await store.updateJobRun(job.id, {
      status: "failed",
      completedAt: nowIso(),
      error: "approval_rejected",
      summary: `Approval rejected; replanning required: ${input.approval.action}`,
      metadata: {
        ...job.metadata,
        replanReason: "approval_rejected",
        replannedAt: nowIso(),
      },
    });
    await store.addAudit(
      input.approval.companyId,
      "agent",
      "supervision.approval.replanned",
      "approval",
      input.approval.id,
      input.approval.action,
    );
    replanned += 1;
  }

  return { executed, replanned };
}

function parseSubtask(payload: unknown): Subtask | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const subtask = (payload as { subtask?: unknown }).subtask;
  const parsed = subtaskSchema.safeParse(subtask);
  return parsed.success ? parsed.data : undefined;
}
