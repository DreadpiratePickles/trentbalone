import { describe, expect, it, vi } from "vitest";
import { store } from "@/lib/store";
import type { Subtask } from "@/lib/planner";
import { persistSupervisionQueuedAction } from "./persistence";
import { resolveSupervisionApprovalExecution } from "./approval-execution";

describe("supervision approval-to-execution wiring", () => {
  it("enqueues the deferred subtask when the linked approval is approved", async () => {
    const enqueueSubtaskRun = vi.fn().mockResolvedValue({ id: "job_exec_1" });
    const company = await store.createCompany({
      name: `Approval Execute ${Date.now()}`,
      brief: { vision: "Approve then execute" },
    });
    const approval = await store.createApproval({
      companyId: company.id,
      action: "app_builder.deploy",
      reason: "Deploy preview after human approval",
    });
    await persistSupervisionQueuedAction({
      companyId: company.id,
      action: "app_builder.deploy",
      riskClass: "costly",
      requestedAt: "2026-05-30T19:00:00.000Z",
      defaultCoolingOffMinutes: 0,
      approvalId: approval.id,
      payload: { subtask: subtask("sub_deploy_1") },
    });

    const result = await resolveSupervisionApprovalExecution({
      approval,
      status: "approved",
      enqueueSubtaskRun,
    });

    const jobs = await store.listJobRuns(company.id);
    const queued = jobs.find((job) => job.metadata.kind === "action_queue");
    const audits = await store.listAuditLogs(company.id);

    expect(result.executed).toBe(1);
    expect(enqueueSubtaskRun).toHaveBeenCalledWith({
      companyId: company.id,
      subtask: expect.objectContaining({ id: "sub_deploy_1" }),
      trigger: "system",
    });
    expect(queued?.status).toBe("completed");
    expect(queued?.metadata).toMatchObject({ executionJobRunId: "job_exec_1" });
    expect(audits.some((audit) => audit.action === "supervision.approval.executed")).toBe(true);
  });

  it("marks the deferred action failed and replanned when approval is rejected", async () => {
    const company = await store.createCompany({
      name: `Approval Reject ${Date.now()}`,
      brief: { vision: "Reject then replan" },
    });
    const approval = await store.createApproval({
      companyId: company.id,
      action: "github.pr.merge",
      reason: "Needs human approval",
    });
    await persistSupervisionQueuedAction({
      companyId: company.id,
      action: "github.pr.merge",
      riskClass: "costly",
      requestedAt: "2026-05-30T19:05:00.000Z",
      defaultCoolingOffMinutes: 0,
      approvalId: approval.id,
      payload: { subtask: subtask("sub_merge_1") },
    });

    const result = await resolveSupervisionApprovalExecution({
      approval,
      status: "rejected",
      enqueueSubtaskRun: vi.fn(),
    });

    const jobs = await store.listJobRuns(company.id);
    const queued = jobs.find((job) => job.metadata.kind === "action_queue");
    const audits = await store.listAuditLogs(company.id);

    expect(result.replanned).toBe(1);
    expect(queued?.status).toBe("failed");
    expect(queued?.metadata).toMatchObject({ replanReason: "approval_rejected" });
    expect(audits.some((audit) => audit.action === "supervision.approval.replanned")).toBe(true);
  });
});

function subtask(id: string): Subtask {
  return {
    id,
    seat: "engineer",
    objective: "Run approved side effect",
    outputContractId: "engineer.v1",
    toolGuidance: [],
    boundaries: ["approval required"],
    input: {},
    contextBundle: {},
    classification: { type: "code", complexity: "standard", reversibility: "costly" },
    budgetCents: 25,
  };
}
