import { describe, expect, it } from "vitest";
import { store } from "@/lib/store";
import { makeId } from "@/lib/utils";
import { buildContentMissionFallbackPlan } from "@/lib/content-mission";
import { buildContentMissionApprovalRequests } from "@/lib/content-mission-approvals";
import {
  markContentMissionActionExecuted,
  recordContentMissionRun,
  syncContentMissionActionApprovals,
} from "@/lib/content-mission-store";
import type { StepRecord } from "@/lib/orchestrator-runtime";

const MISSION_OBJECTIVE =
  "Research viral ideas, create videos, publish to TikTok and X, reply to DMs, follow up with leads, and run Meta ads.";

function missionSteps(): StepRecord[] {
  return [
    {
      id: "s3",
      agentRole: "support",
      title: "Check platform connection",
      status: "blocked",
      output: "TikTok missing.",
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
          summary: "tiktok social account is not connected",
        },
      ],
    },
    {
      id: "s4",
      agentRole: "content",
      title: "Create content package",
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

describe("markContentMissionActionExecuted", () => {
  it("returns undefined when the run has no matching action kind", async () => {
    const company = await store.createCompany({
      name: `Exec ${makeId("test")}`,
      brief: { vision: "test" },
    });
    const runId = makeId("orc");
    // This objective produces only a public_publish action in the ledger.
    const plan = buildContentMissionFallbackPlan("Create videos and publish to YouTube.");
    await recordContentMissionRun({ companyId: company.id, runId, plan, steps: [], status: "running" });

    const kinds = (await store.listContentMissionActions(runId)).map((a) => a.kind);
    expect(kinds).not.toContain("paid_spend_or_boost");

    const result = await markContentMissionActionExecuted({ runId, kind: "paid_spend_or_boost" });
    expect(result).toBeUndefined();
  });

  it("marks the action executed and updates run externalActionStatus", async () => {
    const company = await store.createCompany({
      name: `ExecMark ${makeId("test")}`,
      brief: { vision: "test" },
    });
    const runId = makeId("orc");
    const plan = buildContentMissionFallbackPlan(MISSION_OBJECTIVE);
    const steps = missionSteps();
    await recordContentMissionRun({ companyId: company.id, runId, plan, steps, status: "running" });

    // Approve all actions so none are blocked, then execute publish
    const requests = buildContentMissionApprovalRequests({ companyId: company.id, runId, plan, steps });
    const created = await Promise.all(requests.map((r) => store.createApproval(r)));
    const executableApprovals = created.filter((a) => !a.action.includes("platform_auth"));
    await Promise.all(executableApprovals.map((a) => store.resolveApproval(a.id, "approved")));
    const allApprovals = await store.listApprovals(company.id);
    await syncContentMissionActionApprovals({ runId, approvals: allApprovals });

    const updatedRun = await markContentMissionActionExecuted({
      runId,
      kind: "public_publish",
      externalRef: "ext_post_123",
    });

    expect(updatedRun).toBeDefined();

    const actions = await store.listContentMissionActions(runId);
    const publishAction = actions.find((a) => a.kind === "public_publish");
    expect(publishAction?.status).toBe("executed");
    expect(publishAction?.reason).toContain("ext_post_123");
  });

  it("transitions externalActionStatus to EXECUTED when all executable actions are marked executed", async () => {
    const company = await store.createCompany({
      name: `ExecAll ${makeId("test")}`,
      brief: { vision: "test" },
    });
    const runId = makeId("orc");
    // Use a simpler objective with fewer executable action kinds
    const objective = "Create videos and publish to TikTok.";
    const plan = buildContentMissionFallbackPlan(objective);
    await recordContentMissionRun({ companyId: company.id, runId, plan, steps: [], status: "running" });

    const actions = await store.listContentMissionActions(runId);
    const executableKinds = [...new Set(
      actions.filter((a) => a.kind !== "platform_auth_or_scope_gap").map((a) => a.kind)
    )];

    for (const kind of executableKinds) {
      await markContentMissionActionExecuted({ runId, kind });
    }

    const run = await store.getContentMissionRun(runId);
    expect(run?.externalActionStatus).toBe("EXECUTED");
    expect(run?.status).toBe("completed");
  });

  it("transitions to PARTIALLY_EXECUTED when only some actions are executed", async () => {
    const company = await store.createCompany({
      name: `ExecPartial ${makeId("test")}`,
      brief: { vision: "test" },
    });
    const runId = makeId("orc");
    const plan = buildContentMissionFallbackPlan(MISSION_OBJECTIVE);
    // No steps so there are no tool blockers; this objective yields 4 executable actions.
    await recordContentMissionRun({ companyId: company.id, runId, plan, steps: [], status: "running" });

    const executableKinds = [...new Set(
      (await store.listContentMissionActions(runId))
        .filter((a) => a.kind !== "platform_auth_or_scope_gap")
        .map((a) => a.kind),
    )];
    expect(executableKinds.length).toBeGreaterThan(1);

    // Execute only the first one — the rest remain unexecuted.
    await markContentMissionActionExecuted({ runId, kind: executableKinds[0] });

    const run = await store.getContentMissionRun(runId);
    expect(run?.externalActionStatus).toBe("PARTIALLY_EXECUTED");
  });
});
