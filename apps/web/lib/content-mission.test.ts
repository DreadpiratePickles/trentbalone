import { describe, expect, it } from "vitest";
import {
  buildContentMissionDossier,
  buildContentMissionFallbackPlan,
  buildContentMissionActionLedger,
  buildContentMissionApprovalPacket,
  buildContentMissionProtocolBrief,
  isContentMissionObjective,
} from "@/lib/content-mission";
import {
  assertContentMissionExternalActionAllowed,
  buildContentMissionApprovalRequests,
} from "@/lib/content-mission-approvals";
import type { PlatformAuthReadinessResult } from "@/lib/platform-auth-readiness";
import type { Approval } from "@/lib/types";

describe("content mission planner", () => {
  it("detects publishing, social, video, viral, and ads objectives", () => {
    expect(isContentMissionObjective("produce content and publish it")).toBe(true);
    expect(isContentMissionObjective("make a Higgsfield video for TikTok")).toBe(true);
    expect(isContentMissionObjective("research what's viral and run ads")).toBe(true);
    expect(isContentMissionObjective("fix a database migration")).toBe(false);
  });

  it("builds a research-first publishing plan with approval gates", () => {
    const plan = buildContentMissionFallbackPlan("produce content and publish across LinkedIn and X");
    const roles = plan.steps.map((step) => step.agentRole);

    expect(plan.steps[0]).toMatchObject({
      agentRole: "analyst",
      title: expect.stringContaining("Research viral market signals"),
    });
    expect(roles).toContain("growth");
    expect(roles).toContain("content");
    expect(roles).toContain("support");
    expect(roles).toContain("sales");
    expect(roles).toContain("escalation");
    expect(plan.steps.some((step) => /platform connection/i.test(step.title))).toBe(true);
    expect(plan.steps.find((step) => step.agentRole === "ceo")).toMatchObject({
      needsApproval: true,
      expectedOutput: expect.stringContaining("No external action without approval"),
    });
    expect(plan.successCriteria.join(" ")).toContain("approval-gated");
  });

  it("adds finance and paid-ad approval when the objective includes ads", () => {
    const plan = buildContentMissionFallbackPlan("find viral topics, create videos, and run paid ads");
    const finance = plan.steps.find((step) => step.agentRole === "finance");
    const adLaunch = plan.steps.find((step) => step.title.includes("paid ad campaign"));

    expect(finance?.expectedOutput).toContain("spend cap");
    expect(adLaunch).toMatchObject({
      agentRole: "growth",
      needsApproval: true,
      expectedOutput: expect.stringContaining("Do not spend"),
    });
    expect(plan.successCriteria.join(" ")).toContain("Paid media budget guardrails");
  });

  it("gives the CEO planner an explicit mission protocol brief", () => {
    const brief = buildContentMissionProtocolBrief("publish video content and keep up with DMs");

    expect(brief).toContain("CONTENT PUBLISHING MISSION");
    expect(brief).toContain("Route research/viral trend discovery to analyst");
    expect(brief).toContain("Route comments, DMs");
    expect(brief).toContain("Check platform auth readiness");
    expect(brief).toContain("CEO must consolidate an approval packet");
  });

  it("builds a shared mission dossier for coordinated content, social, and ads work", () => {
    const dossier = buildContentMissionDossier(
      "Research viral ideas, create Higgsfield videos, publish to TikTok and X, reply to DMs, and run Meta ads.",
    );

    expect(dossier).toMatchObject({
      kind: "content_social_ads_mission",
      objective: expect.stringContaining("Research viral ideas"),
      operatingMode: "draft_only_until_approval",
      requiredSocialPlatforms: ["tiktok", "x"],
      requiredMarketingPlatforms: ["meta"],
      socialPublishingRequested: true,
      paidAdsRequested: true,
    });
    expect(dossier?.stages.map((stage) => stage.id)).toEqual([
      "market_research",
      "growth_thesis",
      "platform_readiness",
      "creative_production",
      "safety_audit",
      "engagement_ops",
      "sales_follow_up",
      "paid_media_guardrails",
      "paid_campaign_drafts",
      "ceo_approval_packet",
      "measurement_loop",
    ]);
    expect(dossier?.seatResponsibilities.analyst).toContain("viral");
    expect(dossier?.seatResponsibilities.content).toContain("scripts");
    expect(dossier?.approvalGates).toEqual(expect.arrayContaining([
      "public_publish",
      "comment_or_dm_reply",
      "paid_spend_or_boost",
      "claims_or_brand_safety_exception",
    ]));
    expect(dossier?.memoryLogFields).toEqual(expect.arrayContaining([
      "viral_sources",
      "creative_assets",
      "approval_decisions",
      "engagement_results",
    ]));
  });

  it("builds a CEO-readable approval packet from every seat's mission output", () => {
    const plan = buildContentMissionFallbackPlan("Research viral ideas, create videos, publish to TikTok and X, reply to DMs, and run Meta ads.");
    const packet = buildContentMissionApprovalPacket(plan, [
      {
        id: "s1",
        agentRole: "analyst",
        title: "Research viral market signals and audience demand",
        status: "completed",
        output: "Found 7 viral examples, competitor angles, audience pain, and source links.",
        dependsOn: [],
        rationale: "",
        expectedOutput: "",
        riskLevel: "low",
        needsApproval: false,
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
      {
        id: "s8",
        agentRole: "finance",
        title: "Set paid media budget guardrails",
        status: "completed",
        output: "Cap spend at $25/day until CAC is known.",
        dependsOn: [],
        rationale: "",
        expectedOutput: "",
        riskLevel: "high",
        needsApproval: false,
      },
      {
        id: "s9",
        agentRole: "growth",
        title: "Draft paid ad campaign package",
        status: "blocked",
        output: "Meta launch blocked until payment method and approval are ready.",
        dependsOn: [],
        rationale: "",
        expectedOutput: "",
        riskLevel: "high",
        needsApproval: true,
        toolCalls: [
          {
            adapter: "platform_readiness",
            action: "check",
            status: "needs_approval",
            summary: "Platform readiness blocked external action: tiktok social account is not connected; meta payment status is needs_payment_method",
          },
        ],
      },
    ] as any);

    expect(packet).toContain("## CEO Content Approval Packet");
    expect(packet).toContain("External action status: BLOCKED");
    expect(packet).toContain("No public publish, comment/DM reply, sales send, boost, or ad spend should happen without approval.");
    expect(packet).toContain("analyst — Research viral market signals");
    expect(packet).toContain("Found 7 viral examples");
    expect(packet).toContain("content — Create the content package");
    expect(packet).toContain("Drafted 3 scripts");
    expect(packet).toContain("finance — Set paid media budget guardrails");
    expect(packet).toContain("Cap spend at $25/day");
    expect(packet).toContain("platform_readiness: Platform readiness blocked external action");
    expect(packet).toContain("public_publish");
    expect(packet).toContain("paid_spend_or_boost");
    expect(packet).toContain("learning_loop");
  });

  it("builds an external action ledger with statuses for publish, replies, sales, ads, and auth blockers", () => {
    const plan = buildContentMissionFallbackPlan("Research viral ideas, create videos, publish to TikTok and X, reply to DMs, follow up with leads, and run Meta ads.");
    const steps = [
      {
        id: "s3",
        agentRole: "support",
        title: "Check platform connection and auth readiness",
        status: "blocked",
        output: "TikTok is missing and X auto-publish is disabled.",
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
            summary: "Platform readiness blocked external action: tiktok social account is not connected; x auto-publish is disabled; meta payment status is needs_payment_method",
          },
        ],
      },
      {
        id: "s7",
        agentRole: "sales",
        title: "Prepare lead capture and sales follow-up path",
        status: "completed",
        output: "Drafted follow-up only.",
        dependsOn: [],
        rationale: "",
        expectedOutput: "",
        riskLevel: "medium",
        needsApproval: false,
      },
      {
        id: "s9",
        agentRole: "growth",
        title: "Draft paid ad campaign package",
        status: "completed",
        output: "Drafted Meta ad variants.",
        dependsOn: [],
        rationale: "",
        expectedOutput: "",
        riskLevel: "high",
        needsApproval: true,
      },
    ] as any;

    const ledger = buildContentMissionActionLedger(plan, steps);

    expect(ledger).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "public_publish",
        owner: "ceo",
        status: "blocked",
        approvalGate: "public_publish",
        relatedPlatforms: ["tiktok", "x"],
      }),
      expect.objectContaining({
        kind: "comment_or_dm_reply",
        owner: "support",
        status: "blocked",
        approvalGate: "comment_or_dm_reply",
      }),
      expect.objectContaining({
        kind: "email_or_sales_send",
        owner: "sales",
        status: "needs_approval",
        approvalGate: "email_or_sales_send",
      }),
      expect.objectContaining({
        kind: "paid_spend_or_boost",
        owner: "growth",
        status: "blocked",
        approvalGate: "paid_spend_or_boost",
        relatedPlatforms: ["meta"],
      }),
      expect.objectContaining({
        kind: "platform_auth_or_scope_gap",
        owner: "support",
        status: "blocked",
        approvalGate: "platform_auth_or_scope_gap",
        reason: expect.stringContaining("tiktok social account is not connected"),
      }),
    ]));

    const packet = buildContentMissionApprovalPacket(plan, steps);
    expect(packet).toContain("### External Action Ledger");
    expect(packet).toContain("public_publish — blocked");
    expect(packet).toContain("comment_or_dm_reply — blocked");
    expect(packet).toContain("email_or_sales_send — needs_approval");
    expect(packet).toContain("paid_spend_or_boost — blocked");
    expect(packet).toContain("platform_auth_or_scope_gap — blocked");
  });

  it("builds durable approval request inputs from external action ledger items", () => {
    const plan = buildContentMissionFallbackPlan("Research viral ideas, create videos, publish to TikTok and X, reply to DMs, follow up with leads, and run Meta ads.");
    const requests = buildContentMissionApprovalRequests({
      companyId: "co_1",
      runId: "orc_1",
      plan,
      steps: [
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
              summary: "Platform readiness blocked external action: tiktok social account is not connected; meta payment status is needs_payment_method",
            },
          ],
        },
      ] as any,
    });

    expect(requests).toEqual(expect.arrayContaining([
      expect.objectContaining({
        companyId: "co_1",
        action: "content_mission.public_publish",
        previewKind: "generic",
        toolName: "content_mission:orc_1:action_public_publish",
      }),
      expect.objectContaining({
        companyId: "co_1",
        action: "content_mission.comment_or_dm_reply",
        toolName: "content_mission:orc_1:action_comment_or_dm_reply",
      }),
      expect.objectContaining({
        companyId: "co_1",
        action: "content_mission.email_or_sales_send",
        toolName: "content_mission:orc_1:action_email_or_sales_send",
      }),
      expect.objectContaining({
        companyId: "co_1",
        action: "content_mission.paid_spend_or_boost",
        toolName: "content_mission:orc_1:action_paid_spend_or_boost",
      }),
      expect.objectContaining({
        companyId: "co_1",
        action: "content_mission.platform_auth_or_scope_gap",
        toolName: "content_mission:orc_1:action_platform_auth_or_scope_gap_5",
        reason: expect.stringContaining("tiktok social account is not connected"),
      }),
    ]));

    const publishPreview = JSON.parse(requests.find((request) => request.action === "content_mission.public_publish")?.previewContent ?? "{}");
    expect(publishPreview).toMatchObject({
      runId: "orc_1",
      objective: expect.stringContaining("Research viral ideas"),
      item: expect.objectContaining({ kind: "public_publish", status: "blocked" }),
    });
    expect(publishPreview.packet).toContain("## CEO Content Approval Packet");
  });

  it("blocks external mission actions until the exact content mission approval is approved", () => {
    const approval = approvalRecord({
      status: "pending",
      action: "content_mission.public_publish",
      toolName: "content_mission:orc_1:action_public_publish",
    });

    expect(() => assertContentMissionExternalActionAllowed({
      companyId: "co_1",
      runId: "orc_1",
      kind: "public_publish",
      approvals: [approval],
      platformReadiness: readyPlatform(),
    })).toThrow(/approved content mission approval/i);

    expect(() => assertContentMissionExternalActionAllowed({
      companyId: "co_1",
      runId: "orc_2",
      kind: "public_publish",
      approvals: [{ ...approval, status: "approved" }],
      platformReadiness: readyPlatform(),
    })).toThrow(/approved content mission approval/i);

    expect(() => assertContentMissionExternalActionAllowed({
      companyId: "co_1",
      runId: "orc_1",
      kind: "public_publish",
      approvals: [{ ...approval, status: "approved", action: "content_mission.paid_spend_or_boost" }],
      platformReadiness: readyPlatform(),
    })).toThrow(/approved content mission approval/i);
  });

  it("blocks approved publish and paid actions when platform readiness is not clean", () => {
    const approvals = [
      approvalRecord({
        status: "approved",
        action: "content_mission.public_publish",
        toolName: "content_mission:orc_1:action_public_publish",
      }),
      approvalRecord({
        status: "approved",
        action: "content_mission.paid_spend_or_boost",
        toolName: "content_mission:orc_1:action_paid_spend_or_boost",
      }),
    ];
    const platformReadiness = blockedPlatform(["tiktok social account is not connected"]);

    expect(() => assertContentMissionExternalActionAllowed({
      companyId: "co_1",
      runId: "orc_1",
      kind: "public_publish",
      approvals,
      platformReadiness,
    })).toThrow(/tiktok social account is not connected/i);

    expect(() => assertContentMissionExternalActionAllowed({
      companyId: "co_1",
      runId: "orc_1",
      kind: "paid_spend_or_boost",
      approvals,
      platformReadiness,
    })).toThrow(/tiktok social account is not connected/i);
  });

  it("allows approved external mission actions when approval and readiness both match", () => {
    const approval = approvalRecord({
      status: "approved",
      action: "content_mission.comment_or_dm_reply",
      toolName: "content_mission:orc_1:action_comment_or_dm_reply",
    });

    const result = assertContentMissionExternalActionAllowed({
      companyId: "co_1",
      runId: "orc_1",
      kind: "comment_or_dm_reply",
      approvals: [approval],
      platformReadiness: readyPlatform(),
    });

    expect(result.approval.id).toBe(approval.id);
    expect(result.actionId).toBe("action_comment_or_dm_reply");
  });

  it("keeps platform auth gaps as non-executable blockers", () => {
    expect(() => assertContentMissionExternalActionAllowed({
      companyId: "co_1",
      runId: "orc_1",
      kind: "platform_auth_or_scope_gap",
      approvals: [
        approvalRecord({
          status: "approved",
          action: "content_mission.platform_auth_or_scope_gap",
          toolName: "content_mission:orc_1:action_platform_auth_or_scope_gap_1",
        }),
      ],
      platformReadiness: readyPlatform(),
    })).toThrow(/platform auth.*blocker/i);
  });
});

function approvalRecord(overrides: Partial<Approval>): Approval {
  return {
    id: "approval_1",
    companyId: "co_1",
    action: "content_mission.public_publish",
    reason: "Approve external action",
    status: "pending",
    createdAt: "2026-06-04T00:00:00.000Z",
    toolName: "content_mission:orc_1:action_public_publish",
    ...overrides,
  };
}

function readyPlatform(): PlatformAuthReadinessResult {
  return {
    ready: true,
    approvalRequired: true,
    blockers: [],
    instructions: "Connected platform checks are satisfied for draft execution.",
  };
}

function blockedPlatform(blockers: string[]): PlatformAuthReadinessResult {
  return {
    ready: false,
    approvalRequired: true,
    blockers,
    instructions: `Blocked until platform setup is complete: ${blockers.join("; ")}`,
  };
}
