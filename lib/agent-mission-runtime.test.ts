import { describe, expect, it } from "vitest";
import { store } from "@/lib/store";
import { buildAgentMissionPlan, runAgentMission } from "@/lib/agent-mission-runtime";
import { saveCreativeConnection } from "@/lib/creative-connections";
import { makeId } from "@/lib/utils";

describe("agent mission runtime", () => {
  it("builds a deterministic content mission plan and only adds support/sales for engagement or lead work", () => {
    const publishPlan = buildAgentMissionPlan("Research viral ideas, create videos, publish to TikTok, and run Meta ads.");
    expect(publishPlan.steps.map((step) => step.agentRole)).toEqual([
      "analyst",
      "growth",
      "content",
      "finance",
      "escalation",
      "ceo",
    ]);
    expect(publishPlan.approvalGates).toEqual(expect.arrayContaining(["public_publish", "paid_spend_or_boost"]));

    const engagementPlan = buildAgentMissionPlan("Research viral ideas, publish, reply to DMs, and route interested leads to sales.");
    expect(engagementPlan.steps.map((step) => step.agentRole)).toEqual([
      "analyst",
      "growth",
      "content",
      "finance",
      "support",
      "sales",
      "escalation",
      "ceo",
    ]);
    expect(engagementPlan.approvalGates).toEqual(expect.arrayContaining([
      "public_publish",
      "comment_or_dm_reply",
      "email_or_sales_send",
    ]));
  });

  it("runs the mission, persists ordered steps/events, gates external actions, and writes a CEO report", async () => {
    const company = await store.createCompany({ name: `MissionRuntime ${makeId("co")}`, brief: { vision: "test" } });

    const result = await runAgentMission({
      companyId: company.id,
      objective: "Research viral ideas, create Higgsfield videos, publish to TikTok, reply to DMs, route leads to sales, and run Meta ads.",
      trigger: "command",
      budgetCents: 7500,
    });

    expect(result.run.status).toBe("awaiting_approval");
    expect(result.steps.map((step) => step.agentRole)).toEqual([
      "analyst",
      "growth",
      "content",
      "finance",
      "support",
      "sales",
      "escalation",
      "ceo",
    ]);
    expect(result.approvals.map((approval) => approval.action)).toEqual(expect.arrayContaining([
      "agent_mission.public_publish",
      "agent_mission.comment_or_dm_reply",
      "agent_mission.email_or_sales_send",
      "agent_mission.paid_spend_or_boost",
      "agent_mission.platform_auth_or_scope_gap",
    ]));
    expect(result.artifacts.map((artifact) => artifact.createdByAgent)).toEqual(expect.arrayContaining([
      "analyst",
      "growth",
      "content",
      "ceo",
    ]));
    expect(result.finalSummary).toContain("CEO Mission Report");
    expect(result.finalSummary).toContain("analyst:");
    expect(result.finalSummary).toContain("growth:");
    expect(result.finalSummary).toContain("content:");
    expect(result.finalSummary).toContain("Approvals pending");
    expect(result.finalSummary).toContain("Platform readiness");
    expect(result.finalSummary).toContain("higgsfield creative credentials are missing");
    expect(result.finalSummary).toContain("tiktok social account is not connected");
    expect(result.finalSummary).toContain("meta marketing account is not connected");
    expect(result.finalSummary).toContain("Next action");

    const persisted = await store.getAgentMissionRun(result.run.id);
    const steps = await store.listAgentMissionSteps(result.run.id);
    const events = await store.listAgentMissionEvents(result.run.id);
    const documents = await store.listDocuments(company.id);
    const artifacts = await store.listArtifacts(company.id);
    expect(persisted?.finalSummary).toBe(result.finalSummary);
    expect(steps.map((step) => step.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(events.map((event) => event.kind)).toEqual(expect.arrayContaining([
      "run_start",
      "plan_ready",
      "step_start",
      "step_blocked",
      "approval_requested",
      "artifact_created",
      "run_done",
    ]));
    expect(events.some((event) =>
      event.kind === "step_blocked"
      && Array.isArray(event.payload.blockers)
      && event.payload.blockers.includes("higgsfield creative credentials are missing")
    )).toBe(true);
    expect(documents.some((doc) =>
      doc.source === `agent-mission:${result.run.id}`
      && doc.memoryTier === "episodic"
      && doc.content.includes("## Approvals")
    )).toBe(true);
    expect(artifacts.some((artifact) =>
      artifact.storageKey === `agent-missions/${result.run.id}/memory-log.md`
      && artifact.createdByAgent === "ceo"
    )).toBe(true);
  });

  it("recalls prior mission memory at start and ingests the memory log at finish", async () => {
    const company = await store.createCompany({ name: `MissionMemory ${makeId("co")}`, brief: { vision: "test" } });
    await store.createDocument({
      companyId: company.id,
      type: "agent_note",
      title: "Agent mission memory log: TikTok launch",
      content: "Prior TikTok launch leaned on build-in-public demos and tactical teardowns.",
      source: `agent-mission:${makeId("amr")}`,
      memoryTier: "episodic",
    });

    const result = await runAgentMission({
      companyId: company.id,
      objective: "Plan another TikTok launch with demos",
      trigger: "command",
    });

    expect(result.memoryRecall.source).toBe("local");
    expect(result.memoryRecall.citations.length).toBeGreaterThan(0);
    expect(result.finalSummary).toContain("Prior Memory");

    const events = await store.listAgentMissionEvents(result.run.id);
    expect(events.some((event) => event.kind === "memory_recall")).toBe(true);
    expect(events.some((event) => event.kind === "memory_ingested")).toBe(true);
  });

  it("uses company creative app connections when checking mission readiness", async () => {
    const company = await store.createCompany({ name: `MissionCreative ${makeId("co")}`, brief: { vision: "test" } });
    await saveCreativeConnection(company.id, { app: "higgsfield", apiKey: "higgs_live_123456789" });

    const result = await runAgentMission({
      companyId: company.id,
      objective: "Create Higgsfield videos, publish to TikTok, and run Meta ads.",
      trigger: "command",
      budgetCents: 7500,
    });

    expect(result.platformReadiness.blockers).not.toContain("higgsfield creative credentials are missing");
    expect(result.finalSummary).not.toContain("higgsfield creative credentials are missing");
    expect(result.platformReadiness.blockers).toEqual(expect.arrayContaining([
      "tiktok social account is not connected",
      "meta marketing account is not connected",
    ]));
  });
});
