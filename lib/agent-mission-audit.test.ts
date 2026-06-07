import { describe, expect, it } from "vitest";
import {
  auditAgentMissionApprovalRequested,
  auditAgentMissionApprovalResolved,
  auditAgentMissionPlatformAction,
  auditAgentMissionRunStarted,
} from "@/lib/agent-mission-audit";
import { store } from "@/lib/store";
import { makeId } from "@/lib/utils";

describe("agent mission audit trail", () => {
  it("records run, approval, and platform action events in the company audit log", async () => {
    const company = await store.createCompany({
      name: `AgentMissionAudit ${makeId("co")}`,
      brief: { vision: "audit trail" },
    });
    const runId = makeId("amr");
    const approvalId = makeId("approval");

    await auditAgentMissionRunStarted({
      companyId: company.id,
      runId,
      objective: "Publish after approval",
      budgetCents: 5000,
    });
    await auditAgentMissionApprovalRequested({
      companyId: company.id,
      runId,
      approvalId,
      gate: "public_publish",
      action: "agent_mission.public_publish",
    });
    await auditAgentMissionApprovalResolved({
      companyId: company.id,
      runId,
      approvalId,
      gate: "public_publish",
      status: "approved",
    });
    await auditAgentMissionPlatformAction({
      companyId: company.id,
      runId,
      jobRunId: makeId("job"),
      action: "social.publish",
      platform: "x",
      status: "completed",
      externalRef: "sandbox_x_post_demo",
      executionMode: "sandbox",
    });

    const logs = await store.listAuditLogs(company.id);
    const actions = logs.map((entry) => entry.action);
    expect(actions).toEqual(expect.arrayContaining([
      "agent_mission.run_started",
      "agent_mission.approval_requested",
      "agent_mission.approval_resolved",
      "agent_mission.platform_action_completed",
    ]));
    expect(logs.find((entry) => entry.action === "agent_mission.platform_action_completed")?.summary).toContain("[Simulated]");
  });
});
