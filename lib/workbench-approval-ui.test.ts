import { describe, expect, it } from "vitest";
import { findPendingWorkbenchPlanApproval, latestWorkbenchUserPrompt } from "@/lib/workbench-approval-ui";

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

  it("continues from the latest user prompt, not the placeholder objective", () => {
    expect(latestWorkbenchUserPrompt([
      { role: "user", content: "make me spa agency website" },
      { role: "assistant", content: "Session paused for plan approval." },
    ], "yo")).toBe("make me spa agency website");

    expect(latestWorkbenchUserPrompt([], "fallback objective")).toBe("fallback objective");
  });
});
