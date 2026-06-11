import { describe, expect, it } from "vitest";
import { store } from "@/lib/store";
import {
  inferApprovalAction,
  isExternalWriteApprovalBlock,
  pauseWorkbenchForCommandApproval,
} from "@/lib/workbench-approval-gate";

describe("workbench-approval-gate", () => {
  it("maps git push to git_push gate", () => {
    expect(inferApprovalAction("git push origin main")).toBe("git_push");
  });

  it("detects external write approval blocks", () => {
    expect(isExternalWriteApprovalBlock({
      blocked: true,
      blockedReason: "external_write_requires_approval",
    })).toBe(true);
    expect(isExternalWriteApprovalBlock({ blocked: true, blockedReason: "policy" })).toBe(false);
  });

  it("pauses the session and creates an approval record", async () => {
    const company = await store.createCompany({
      name: `Approval Gate ${Date.now()}`,
      brief: { vision: "test" },
    });
    const session = await store.createWorkbenchSession({
      companyId: company.id,
      agentRole: "engineer",
      agentMode: "build",
      provider: "mock_local",
      status: "running",
      objective: "Deploy after review",
      metadata: {
        networkPolicy: "deny_all",
        allowedHosts: [],
        maxRuntimeSeconds: 600,
        maxCostCents: 100,
        approvalRequiredFor: ["git_push", "deploy"],
        rollbackAvailable: true,
      },
    });

    const approvalId = await pauseWorkbenchForCommandApproval(session, "git push origin main");
    const refreshed = await store.getWorkbenchSession(session.id);
    const approvals = await store.listApprovals(company.id);

    expect(refreshed?.status).toBe("paused");
    expect(approvalId).toBeTruthy();
    expect(approvals.some((a) => a.id === approvalId && a.status === "pending")).toBe(true);
    expect(approvals.find((a) => a.id === approvalId)?.toolName).toBe(`workbench:${session.id}:git_push`);

    const events = await store.listWorkbenchEvents(session.id);
    expect(events.some((e) => e.type === "approval" && e.status === "needs_approval")).toBe(true);
  });
});
