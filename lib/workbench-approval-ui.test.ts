import { describe, expect, it } from "vitest";
import { findPendingWorkbenchPlanApproval } from "@/lib/workbench-approval-ui";

describe("workbench approval UI helpers", () => {
  it("finds only the pending plan approval for the active Workbench session", () => {
    const approval = findPendingWorkbenchPlanApproval("workbench_1", [
      {
        id: "approval_other",
        status: "pending",
        action: "workbench.plan",
        toolName: "workbench:workbench_2:plan",
        reason: "Other session",
        previewContent: "Plan fingerprint: other",
      },
      {
        id: "approval_done",
        status: "approved",
        action: "workbench.plan",
        toolName: "workbench:workbench_1:plan",
        reason: "Old plan",
        previewContent: "Plan fingerprint: old",
      },
      {
        id: "approval_active",
        status: "pending",
        action: "workbench.plan",
        toolName: "workbench:workbench_1:plan",
        reason: "Current plan",
        previewContent: "Plan fingerprint: current\nTitle: Build app",
      },
    ]);

    expect(approval?.id).toBe("approval_active");
    expect(approval?.previewContent).toContain("Build app");
  });
});
