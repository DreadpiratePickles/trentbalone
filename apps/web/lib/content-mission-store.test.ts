import { describe, expect, it } from "vitest";
import { store } from "@/lib/store";
import { makeId } from "@/lib/utils";
import { buildContentMissionFallbackPlan } from "@/lib/content-mission";
import { buildContentMissionApprovalRequests } from "@/lib/content-mission-approvals";
import {
  finalizeContentMissionRun,
  recordContentMissionRun,
  syncContentMissionActionApprovals,
} from "@/lib/content-mission-store";
import { persistContentMissionMemoryLog } from "@/lib/content-mission-memory-log";
import type { StepRecord } from "@/lib/orchestrator-runtime";

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
          summary:
            "Platform readiness blocked external action: tiktok social account is not connected; meta payment status is needs_payment_method",
        },
      ],
    },
    {
      id: "s4",
      agentRole: "content",
      title: "Create the content package and media prompts",
      status: "completed",
      output: "Drafted 3 scripts, captions, CTAs, and Higgsfield video prompts.",
      dependsOn: [],
      rationale: "",
      expectedOutput: "",
      riskLevel: "medium",
      needsApproval: false,
    },
  ] as unknown as StepRecord[];
}

describe("content mission durable store", () => {
  it("persists a mission run and external-action ledger for a content objective", async () => {
    const company = await store.createCompany({
      name: `Mission ${makeId("test")}`,
      brief: { vision: "ship viral content safely" },
    });
    const runId = makeId("orc");
    const plan = buildContentMissionFallbackPlan(MISSION_OBJECTIVE);

    const run = await recordContentMissionRun({
      companyId: company.id,
      runId,
      cycleId: runId,
      plan,
      steps: missionSteps(),
      budgetCents: 500,
      status: "running",
    });

    expect(run).not.toBeNull();
    expect(run).toMatchObject({
      id: runId,
      companyId: company.id,
      objective: MISSION_OBJECTIVE,
      operatingMode: "draft_only_until_approval",
      status: "running",
      socialPublishingRequested: true,
      paidAdsRequested: true,
      externalActionStatus: "BLOCKED",
      budgetCents: 500,
    });
    expect(run?.requiredSocialPlatforms).toEqual(expect.arrayContaining(["tiktok", "x"]));
    expect(run?.requiredMarketingPlatforms).toEqual(expect.arrayContaining(["meta"]));

    const fetched = await store.getContentMissionRun(runId);
    expect(fetched?.id).toBe(runId);

    const actions = await store.listContentMissionActions(runId);
    expect(actions.map((action) => action.kind)).toEqual(
      expect.arrayContaining([
        "public_publish",
        "comment_or_dm_reply",
        "email_or_sales_send",
        "paid_spend_or_boost",
        "platform_auth_or_scope_gap",
      ]),
    );
    const publish = actions.find((action) => action.kind === "public_publish");
    expect(publish).toMatchObject({
      runId,
      ledgerItemId: "action_public_publish",
      status: "blocked",
      approvalGate: "public_publish",
    });
    expect(publish?.relatedPlatforms).toEqual(expect.arrayContaining(["tiktok", "x"]));
  });

  it("ignores non-content objectives", async () => {
    const company = await store.createCompany({
      name: `NonMission ${makeId("test")}`,
      brief: { vision: "infra work" },
    });
    const runId = makeId("orc");
    const plan = { ...buildContentMissionFallbackPlan(MISSION_OBJECTIVE), objective: "fix a database migration" };

    const run = await recordContentMissionRun({
      companyId: company.id,
      runId,
      plan,
      steps: [],
    });

    expect(run).toBeNull();
    expect(await store.getContentMissionRun(runId)).toBeUndefined();
    expect(await store.listContentMissionActions(runId)).toEqual([]);
  });

  it("links approved approvals back to mission actions", async () => {
    const company = await store.createCompany({
      name: `MissionApprove ${makeId("test")}`,
      brief: { vision: "approve safely" },
    });
    const runId = makeId("orc");
    const plan = buildContentMissionFallbackPlan(MISSION_OBJECTIVE);
    const steps = missionSteps();
    await recordContentMissionRun({ companyId: company.id, runId, plan, steps, status: "running" });

    const requests = buildContentMissionApprovalRequests({ companyId: company.id, runId, plan, steps });
    const created = await Promise.all(requests.map((request) => store.createApproval(request)));
    const publishApproval = created.find((a) => a.action === "content_mission.public_publish");
    expect(publishApproval).toBeDefined();
    await store.resolveApproval(publishApproval!.id, "approved");

    const approvals = await store.listApprovals(company.id);
    await syncContentMissionActionApprovals({ runId, approvals });

    const actions = await store.listContentMissionActions(runId);
    const publish = actions.find((action) => action.kind === "public_publish");
    expect(publish?.approvalId).toBe(publishApproval!.id);
    expect(publish?.status).toBe("approved");

    const reply = actions.find((action) => action.kind === "comment_or_dm_reply");
    expect(reply?.approvalId).toBeDefined();
    expect(reply?.status).toBe("needs_approval");
  });

  it("persists a mission memory log artifact and links it to the run", async () => {
    const company = await store.createCompany({
      name: `MissionLog ${makeId("test")}`,
      brief: { vision: "remember what we learned" },
    });
    const runId = makeId("orc");
    const plan = buildContentMissionFallbackPlan(MISSION_OBJECTIVE);
    const steps = missionSteps();
    await recordContentMissionRun({ companyId: company.id, runId, plan, steps, status: "running" });
    await finalizeContentMissionRun({ runId, status: "completed", summary: "Drafts ready, publish blocked.", costCents: 42 });

    const result = await persistContentMissionMemoryLog(runId, {
      plan,
      steps,
      finalSummary: "Drafts ready, publish blocked.",
    });

    expect(result).not.toBeNull();
    expect(result?.markdown).toContain("# Content Mission Memory Log");
    expect(result?.markdown).toContain(MISSION_OBJECTIVE);
    expect(result?.markdown).toContain("## External Action Ledger");
    expect(result?.markdown).toContain("public_publish");
    expect(result?.markdown).toContain("Drafts ready, publish blocked.");

    const artifacts = await store.listArtifacts(company.id);
    const logArtifact = artifacts.find((artifact) => artifact.storageKey === `content-mission/${runId}/memory-log.md`);
    expect(logArtifact).toBeDefined();
    expect(logArtifact?.type).toBe("operating_memo");

    const run = await store.getContentMissionRun(runId);
    expect(run?.memoryLogArtifactId).toBe(logArtifact?.id);
  });
});
