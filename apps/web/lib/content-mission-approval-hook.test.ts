import { describe, expect, it } from "vitest";
import { store } from "@/lib/store";
import { makeId } from "@/lib/utils";
import { buildContentMissionFallbackPlan } from "@/lib/content-mission";
import { buildContentMissionApprovalRequests } from "@/lib/content-mission-approvals";
import { recordContentMissionRun } from "@/lib/content-mission-store";
import {
  parseContentMissionRunId,
  syncContentMissionForApproval,
} from "@/lib/content-mission-approval-hook";
import type { StepRecord } from "@/lib/orchestrator-runtime";
import type { Approval } from "@/lib/types";

const MISSION_OBJECTIVE =
  "Research viral ideas, create videos, publish to TikTok and X, reply to DMs, follow up with leads, and run Meta ads.";

function missionSteps(): StepRecord[] {
  return [
    {
      id: "s3",
      agentRole: "support",
      title: "Check platform connection and auth readiness",
      status: "blocked",
      output: "TikTok is missing and Meta needs payment.",
      dependsOn: [],
      rationale: "",
      expectedOutput: "",
      riskLevel: "high",
      needsApproval: false,
      toolCalls: [
        {
          adapter: "platform_readiness",
          action: "check",
          status: "needs_approval",
          summary: "tiktok social account is not connected; meta payment status is needs_payment_method",
        },
      ],
    },
    {
      id: "s4",
      agentRole: "content",
      title: "Create the content package",
      status: "completed",
      output: "Drafted 3 scripts.",
      dependsOn: [],
      rationale: "",
      expectedOutput: "",
      riskLevel: "medium",
      needsApproval: false,
    },
  ] as unknown as StepRecord[];
}

describe("parseContentMissionRunId", () => {
  it("extracts runId from a content_mission toolName", () => {
    const approval = {
      toolName: "content_mission:orc_abc123:action_public_publish",
    } as Approval;
    expect(parseContentMissionRunId(approval)).toBe("orc_abc123");
  });

  it("returns undefined for non-content-mission toolName", () => {
    expect(parseContentMissionRunId({ toolName: "step_approval:some-step" } as Approval)).toBeUndefined();
    expect(parseContentMissionRunId({ toolName: undefined } as Approval)).toBeUndefined();
    expect(parseContentMissionRunId({ toolName: "content_mission:only-two" } as Approval)).toBeUndefined();
  });
});

describe("syncContentMissionForApproval", () => {
  it("returns undefined for a non-content-mission approval", async () => {
    const approval = {
      id: makeId("appr"),
      companyId: makeId("co"),
      action: "step_approval",
      toolName: "orchestrator:step:123",
      status: "approved",
      reason: "approved",
      createdAt: new Date().toISOString(),
    } as Approval;
    const result = await syncContentMissionForApproval(approval);
    expect(result).toBeUndefined();
  });

  it("syncs the action ledger and recomputes run status when a mission approval is resolved", async () => {
    const company = await store.createCompany({
      name: `Hook ${makeId("test")}`,
      brief: { vision: "test" },
    });
    const runId = makeId("orc");
    const plan = buildContentMissionFallbackPlan(MISSION_OBJECTIVE);
    const steps = missionSteps();
    await recordContentMissionRun({ companyId: company.id, runId, plan, steps, status: "running" });

    // Create approvals then approve the public_publish one
    const requests = buildContentMissionApprovalRequests({ companyId: company.id, runId, plan, steps });
    const created = await Promise.all(requests.map((r) => store.createApproval(r)));
    const publishApproval = created.find((a) => a.action === "content_mission.public_publish")!;
    await store.resolveApproval(publishApproval.id, "approved");

    // The resolved approval object
    const resolved = { ...publishApproval, status: "approved" as const };
    const updatedRun = await syncContentMissionForApproval(resolved);

    expect(updatedRun).toBeDefined();

    const actions = await store.listContentMissionActions(runId);
    const publishAction = actions.find((a) => a.kind === "public_publish");
    expect(publishAction?.status).toBe("approved");
    expect(publishAction?.approvalId).toBe(publishApproval.id);
  });

  it("returns undefined when the mission run does not exist", async () => {
    const approval = {
      id: makeId("appr"),
      companyId: makeId("co"),
      action: "content_mission.public_publish",
      toolName: "content_mission:nonexistent-run:action_public_publish",
      status: "approved",
      reason: "approved",
      createdAt: new Date().toISOString(),
    } as Approval;
    const result = await syncContentMissionForApproval(approval);
    expect(result).toBeUndefined();
  });
});
