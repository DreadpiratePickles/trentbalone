import { describe, expect, it } from "vitest";
import { store } from "@/lib/store";
import {
  ensureWorkbenchPlanApproval,
  fingerprintWorkbenchPlan,
  inferApprovalAction,
  isExternalWriteApprovalBlock,
  pauseWorkbenchForCommandApproval,
  shouldRequireWorkbenchPlanApproval,
  summarizeWorkbenchPlanActions,
} from "@/lib/workbench-approval-gate";
import { defaultAutonomySettings } from "@/lib/autonomy-settings";

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

  it("creates a stable implementation plan approval before writes", async () => {
    const company = await store.createCompany({
      name: `Plan Gate ${Date.now()}`,
      brief: { vision: "approve plans" },
    });
    const session = await store.createWorkbenchSession({
      companyId: company.id,
      agentRole: "engineer",
      agentMode: "build",
      provider: "mock_local",
      status: "running",
      objective: "Build after plan approval",
      metadata: {
        networkPolicy: "deny_all",
        allowedHosts: [],
        maxRuntimeSeconds: 600,
        maxCostCents: 100,
        approvalRequiredFor: ["workbench_plan"],
        rollbackAvailable: true,
      },
    });
    const actions = [
      { type: "file" as const, filePath: "index.html", content: "<h1>Hi</h1>" },
      { type: "shell" as const, command: "npm test" },
    ];

    const first = await ensureWorkbenchPlanApproval(session, "Build approved UI", actions);
    const pending = await store.getApproval(first.approvalId);

    expect(first.approved).toBe(false);
    expect(first.fingerprint).toBe(fingerprintWorkbenchPlan(actions));
    expect(pending?.status).toBe("pending");
    expect(pending?.action).toBe("workbench.plan");
    expect(pending?.toolName).toBe(`workbench:${session.id}:plan`);
    expect(pending?.previewContent).toContain("Plan fingerprint:");
    expect(pending?.previewContent).toContain("write index.html");
    expect(summarizeWorkbenchPlanActions(actions)).toContain("run npm test");

    await store.resolveApproval(first.approvalId, "approved");
    const second = await ensureWorkbenchPlanApproval(session, "Build approved UI", actions);
    expect(second).toMatchObject({ approved: true, approvalId: first.approvalId, fingerprint: first.fingerprint });
  });

  it("skips only the Workbench plan approval gate for autonomous companies", async () => {
    const autonomousCompany = await store.createCompany({
      name: `Autonomous Workbench ${Date.now()}`,
      brief: {
        vision: "test autonomous workbench",
      },
    });
    const supervisedCompany = await store.createCompany({
      name: `Supervised Workbench ${Date.now()}`,
      brief: {
        vision: "test supervised workbench",
      },
    });
    await store.updateCompany(autonomousCompany.id, {
      brief: { ...autonomousCompany.brief, autonomy: defaultAutonomySettings("autonomous") },
    });
    await store.updateCompany(supervisedCompany.id, {
      brief: { ...supervisedCompany.brief, autonomy: defaultAutonomySettings("supervised") },
    });
    const baseMetadata = {
      networkPolicy: "deny_all" as const,
      allowedHosts: [],
      maxRuntimeSeconds: 600,
      maxCostCents: 100,
      approvalRequiredFor: ["workbench_plan", "deploy"],
      rollbackAvailable: true,
    };
    const autonomousSession = await store.createWorkbenchSession({
      companyId: autonomousCompany.id,
      agentRole: "engineer",
      agentMode: "build",
      provider: "mock_local",
      status: "running",
      objective: "Build without plan pause",
      metadata: baseMetadata,
    });
    const supervisedSession = await store.createWorkbenchSession({
      companyId: supervisedCompany.id,
      agentRole: "engineer",
      agentMode: "build",
      provider: "mock_local",
      status: "running",
      objective: "Build with plan pause",
      metadata: baseMetadata,
    });

    await expect(shouldRequireWorkbenchPlanApproval(autonomousSession)).resolves.toBe(false);
    await expect(shouldRequireWorkbenchPlanApproval(supervisedSession)).resolves.toBe(true);
  });
});
