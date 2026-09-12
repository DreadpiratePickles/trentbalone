import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentMissionTraceView } from "@/components/agent-mission-client";

describe("AgentMissionTraceView", () => {
  it("renders mission status, seat work, approvals, artifacts, memory, and timeline evidence", () => {
    const html = renderToStaticMarkup(
      <AgentMissionTraceView
        onResolveApproval={() => undefined}
        detail={{
          run: {
            id: "amr_1",
            companyId: "co_1",
            objective: "Research viral ideas, create videos, reply to DMs, and run ads.",
            missionType: "content_social_ads",
            status: "awaiting_approval",
            trigger: "command",
            ownerSeat: "ceo",
            budgetCents: 7500,
            costCents: 42,
            approvalPolicy: {},
            modelPolicy: {},
            finalSummary: "CEO Mission Report: approve the launch packet next.",
            startedAt: "2026-06-04T00:00:00.000Z",
            updatedAt: "2026-06-04T00:01:00.000Z",
          },
          steps: [
            {
              id: "step_1",
              runId: "amr_1",
              companyId: "co_1",
              seq: 1,
              agentRole: "analyst",
              title: "Trend research",
              objective: "Find viral angles.",
              status: "completed",
              dependsOn: [],
              expectedOutput: "Trend signals",
              output: "Five content angles from viral formats.",
              toolCalls: [{ name: "steel.search" }],
              costCents: 12,
            },
            {
              id: "step_2",
              runId: "amr_1",
              companyId: "co_1",
              seq: 2,
              agentRole: "finance",
              title: "Spend guard",
              objective: "Check ad budget.",
              status: "awaiting_approval",
              dependsOn: ["step_1"],
              expectedOutput: "Spend approval",
              output: "Paid spend requires approval.",
              costCents: 8,
              approvalId: "approval_1",
            },
          ],
          events: [
            { id: "event_1", runId: "amr_1", companyId: "co_1", seq: 1, kind: "run_start", payload: { title: "Mission started" }, createdAt: "2026-06-04T00:00:01.000Z" },
            { id: "event_2", runId: "amr_1", companyId: "co_1", seq: 2, kind: "step_blocked", payload: { blockers: ["higgsfield creative credentials are missing", "tiktok social account is not connected"] }, createdAt: "2026-06-04T00:00:02.000Z" },
            { id: "event_3", runId: "amr_1", companyId: "co_1", stepId: "step_2", seq: 3, kind: "approval_requested", payload: { gate: "paid_spend_or_boost", detail: "Finance approval required" }, createdAt: "2026-06-04T00:00:03.000Z" },
            { id: "event_4", runId: "amr_1", companyId: "co_1", seq: 4, kind: "viral_trend_research_ready", payload: { artifactId: "artifact_trends" }, createdAt: "2026-06-04T00:00:04.000Z" },
            { id: "event_5", runId: "amr_1", companyId: "co_1", seq: 5, kind: "analytics_feedback_ready", payload: { artifactId: "artifact_analytics" }, createdAt: "2026-06-04T00:00:05.000Z" },
            { id: "event_6", runId: "amr_1", companyId: "co_1", seq: 6, kind: "publishing_schedule_ready", payload: { artifactId: "artifact_schedule" }, createdAt: "2026-06-04T00:00:06.000Z" },
            { id: "event_7", runId: "amr_1", companyId: "co_1", seq: 7, kind: "inbox_ingestion_ready", payload: { artifactId: "artifact_inbox" }, createdAt: "2026-06-04T00:00:07.000Z" },
            { id: "event_8", runId: "amr_1", companyId: "co_1", seq: 8, kind: "approval_dashboard_ready", payload: { artifactId: "artifact_dashboard" }, createdAt: "2026-06-04T00:00:08.000Z" },
          ],
          approvals: [
            { id: "approval_public", action: "agent_mission.public_publish", status: "pending", reason: "Public post requires approval", previewContent: "Launch post draft" },
            { id: "approval_reply", action: "agent_mission.comment_or_dm_reply", status: "pending", reason: "DM reply requires approval", previewContent: "Reply draft" },
            { id: "approval_sales", action: "agent_mission.email_or_sales_send", status: "pending", reason: "Sales outreach requires approval", previewContent: "Sales draft" },
            { id: "approval_1", action: "agent_mission.paid_spend_or_boost", status: "pending", reason: "Paid ad launch requires approval", previewContent: "Meta campaign draft" },
          ],
          approvalDashboard: {
            summary: {
              total: 4,
              pending: 4,
              approved: 0,
              rejected: 0,
              linkedTargets: 4,
              providerActions: 2,
            },
            groups: [
              {
                gate: "public_publish",
                label: "Public publish",
                action: "agent_mission.public_publish",
                total: 1,
                pending: 1,
                approved: 0,
                rejected: 0,
                executionMode: "external_write",
                riskLabel: "Public channel write",
              },
              {
                gate: "paid_spend_or_boost",
                label: "Paid spend",
                action: "agent_mission.paid_spend_or_boost",
                total: 1,
                pending: 1,
                approved: 0,
                rejected: 0,
                executionMode: "paid_spend",
                riskLabel: "Budget/spend change",
              },
            ],
            cards: [
              {
                approvalId: "approval_public",
                gate: "public_publish",
                label: "Public publish",
                action: "agent_mission.public_publish",
                status: "pending",
                reason: "Public post requires approval",
                previewContent: "Launch post draft",
                executionMode: "external_write",
                riskLabels: ["Public channel write", "Provider action queued"],
                nextAction: "Approve to execute queued provider actions; reject to fail the mission safely.",
                targets: [
                  { kind: "social_post", id: "post_1", label: "Post post_1", platform: "instagram", status: "scheduled" },
                  { kind: "provider_action", id: "job_publish", label: "social.publish", platform: "instagram", status: "completed" },
                ],
              },
              {
                approvalId: "approval_1",
                gate: "paid_spend_or_boost",
                label: "Paid spend",
                action: "agent_mission.paid_spend_or_boost",
                status: "pending",
                reason: "Paid ad launch requires approval",
                previewContent: "Meta campaign draft",
                executionMode: "paid_spend",
                riskLabels: ["Budget/spend change", "Provider action queued"],
                nextAction: "Approve only after spend, creative, and destination checks are acceptable.",
                targets: [
                  { kind: "ad_campaign", id: "campaign_1", label: "Campaign campaign_1", platform: "meta", status: "draft" },
                  { kind: "provider_action", id: "job_1", label: "ads.launch", platform: "meta", status: "failed" },
                ],
              },
            ],
          },
          artifacts: [
            { id: "artifact_1", title: "CEO report", storageKey: "agent-missions/amr_1/ceo-report.md" },
            { id: "artifact_2", title: "Memory log", storageKey: "agent-missions/amr_1/memory-log.md" },
            { id: "artifact_trends", title: "Viral trend research loop", storageKey: "agent-missions/amr_1/loops/viral-trend-research.md" },
            { id: "artifact_analytics", title: "Analytics feedback loop", storageKey: "agent-missions/amr_1/loops/analytics-feedback.md" },
            { id: "artifact_schedule", title: "Publishing schedule", storageKey: "agent-missions/amr_1/loops/publishing-schedule.md" },
            { id: "artifact_inbox", title: "Inbox ingestion loop", storageKey: "agent-missions/amr_1/loops/inbox-ingestion.md" },
            { id: "artifact_dashboard", title: "Human approval dashboard", storageKey: "agent-missions/amr_1/loops/human-approval-dashboard.md" },
            { id: "artifact_higgs", title: "Higgsfield sandbox creative asset", storageKey: "agent-missions/amr_1/creative/higgsfield-asset.md" },
            { id: "artifact_hyper", title: "HyperFrames sandbox creative asset", storageKey: "agent-missions/amr_1/creative/hyperframes-asset.md" },
            { id: "artifact_open", title: "Open Generative AI sandbox creative asset", storageKey: "agent-missions/amr_1/creative/open-generative-ai-asset.md" },
          ],
          memoryLog: { id: "artifact_2", title: "Memory log", storageKey: "agent-missions/amr_1/memory-log.md" },
          executions: {
            socialPosts: [
              {
                id: "post_1",
                platform: "instagram",
                status: "scheduled",
                approvalId: "approval_public",
                content: "Approved launch post",
                scheduledFor: "2026-06-04T17:00:00.000Z",
                externalPostId: "ext_post_123",
                mediaUrls: ["https://cdn.higgsfield.test/launch.mp4"],
                metadata: { creativeAssetSource: "higgsfield" },
              },
            ],
            outreachDrafts: [
              { id: "draft_1", platform: "instagram", status: "approved", approvalId: "approval_1", purpose: "comment_or_dm_reply" },
            ],
            adCampaigns: [
              { id: "campaign_1", platform: "meta", status: "draft", approvalId: "approval_1", name: "AgentMission amr_1" },
            ],
            adCreativeVariants: [
              {
                id: "creative_1",
                campaignId: "campaign_1",
                variantKey: "higgsfield-video",
                headline: "See Trent ship the launch",
                assetUrl: "https://cdn.higgsfield.test/launch.mp4",
                moderationStatus: "approved",
                brandSafetyStatus: "approved",
                externalCreativeId: "sandbox_meta_creative_123",
              },
            ],
            providerActions: [
              {
                id: "job_publish",
                type: "platform_action",
                status: "completed",
                summary: "Queued platform action: social.publish instagram",
                metadata: {
                  action: "social.publish",
                  platform: "instagram",
                  provider: "Social:Instagram",
                  targetId: "post_1",
                },
              },
              {
                id: "job_1",
                type: "platform_action",
                status: "failed",
                summary: "Queued platform action: ads.launch meta",
                metadata: {
                  action: "ads.launch",
                  platform: "meta",
                  provider: "Ads:Meta",
                  targetId: "campaign_1",
                  result: {
                    externalCreativeId: "sandbox_meta_creative_123",
                    assetUrl: "https://cdn.higgsfield.test/launch.mp4",
                  },
                  error: "Meta Graph createCreative failed: Ad creative was rejected by policy review",
                  errorCode: "rejected_ad_creative",
                  errorKind: "rejected_creative",
                  recoverable: false,
                },
              },
            ],
          },
          platformFailures: {
            summary: {
              total: 1,
              recoverable: 0,
              manualReview: 1,
              rateLimited: 0,
              expiredTokens: 0,
            },
            failures: [
              {
                jobRunId: "job_1",
                action: "ads.launch",
                provider: "Ads:Meta",
                platform: "meta",
                targetId: "campaign_1",
                status: "failed",
                error: "Meta Graph createCreative failed: Ad creative was rejected by policy review",
                errorCode: "rejected_ad_creative",
                errorKind: "rejected_creative",
                recoverable: false,
                nextAction: "Revise the creative/content and resubmit for approval before retrying.",
              },
            ],
          },
          performanceFeedback: {
            socialSnapshots: [
              {
                id: "snapshot_1",
                platform: "instagram",
                periodStart: "2026-06-04T00:00:00.000Z",
                periodEnd: "2026-06-05T00:00:00.000Z",
                metrics: { impressions: 12000, engagements: 1800, clicks: 220 },
                report: { recommendation: "Repurpose the proof demo.", engagementRate: 0.15 },
              },
            ],
            adOptimizationRuns: [
              {
                id: "opt_1",
                runDate: "2026-06-05",
                status: "completed",
                inputMetrics: { campaignId: "campaign_1", conversions: 11 },
                decisions: [{ action: "scale_winner", reason: "CPA is inside the guardrail." }],
              },
            ],
            documents: [
              { id: "doc_feedback", title: "Content performance feedback 2026-06-05", source: "content-performance-feedback", createdAt: "2026-06-05T00:00:00.000Z" },
            ],
            recommendations: [
              "Repurpose the proof demo.",
              "Meta campaign AgentMission amr_1: CPA is inside the guardrail.",
            ],
          },
          inboxEvidence: {
            summary: {
              conversations: 1,
              inboundMessages: 1,
              outboundMessages: 0,
              replyDrafts: 1,
              openConversations: 1,
            },
            conversations: [
              {
                conversationId: "socconv_1",
                platform: "instagram",
                externalThreadId: "thread_1",
                status: "open",
                contact: {
                  id: "soccontact_1",
                  handle: "buyer_ops",
                  displayName: "Buyer Ops",
                  externalContactId: "buyer_ops",
                  engagementState: "engaged",
                },
                latestMessage: {
                  id: "socmsg_1",
                  direction: "inbound",
                  kind: "comment",
                  content: "Can Trent publish clips for us?",
                  sentAt: "2026-06-04T00:10:00.000Z",
                },
                messages: [
                  {
                    id: "socmsg_1",
                    direction: "inbound",
                    kind: "comment",
                    content: "Can Trent publish clips for us?",
                    sentAt: "2026-06-04T00:10:00.000Z",
                  },
                ],
                replyDrafts: [
                  {
                    id: "draft_1",
                    platform: "instagram",
                    purpose: "comment_or_dm_reply",
                    status: "approved",
                    approvalId: "approval_1",
                    message: "Approved reply",
                  },
                ],
              },
            ],
          },
          platformReadiness: {
            ready: false,
            approvalRequired: true,
            blockers: [
              "higgsfield creative credentials are missing",
              "tiktok social credentials are missing",
              "meta ads credentials are missing",
            ],
            instructions: "Blocked until platform setup is complete.",
            requirements: {
              requiredSocialPlatforms: ["tiktok"],
              requiredMarketingPlatforms: ["meta"],
              requiredCreativeApps: ["higgsfield"],
              socialPublishingRequested: true,
              paidAdsRequested: true,
              creativeGenerationRequested: true,
            },
            creativeConnections: [
              { app: "higgsfield", provider: "Higgsfield", status: "needs_credentials", source: "missing", scopes: ["creative:generate"] },
            ],
            socialConnections: [
              { platform: "tiktok", provider: "Social:TikTok", status: "needs_credentials", source: "company", scopes: ["post:write"] },
            ],
            marketingConnections: [
              { platform: "meta", provider: "Ads:Meta", status: "connected", source: "company", scopes: ["ads:read"] },
            ],
          },
        }}
      />
    );

    expect(html).toContain("agent mission trace");
    expect(html).toContain("Research viral ideas");
    expect(html).toContain("awaiting_approval");
    expect(html).toContain("42c");
    expect(html).toContain("Trend research");
    expect(html).toContain("Five content angles");
    expect(html).toContain("Spend guard");
    expect(html).toContain("approval_1");
    expect(html).toContain("approval review queue");
    expect(html).toContain("external action approvals");
    expect(html).toContain("approval impact");
    expect(html).toContain("4 pending");
    expect(html).toContain("4 linked records");
    expect(html).toContain("2 provider jobs");
    expect(html).toContain("Public publish / 1 pending");
    expect(html).toContain("Reply / DM / 1 pending");
    expect(html).toContain("Sales send / 1 pending");
    expect(html).toContain("Paid spend / 1 pending");
    expect(html).toContain("Public channel write");
    expect(html).toContain("Budget/spend change");
    expect(html).toContain("Provider action queued");
    expect(html).toContain("Approve to execute queued provider actions");
    expect(html).toContain("Approve only after spend");
    expect(html).toContain("Post post_1 / instagram / scheduled");
    expect(html).toContain("social.publish / instagram / completed");
    expect(html).toContain("Campaign campaign_1 / meta / draft");
    expect(html).toContain("ads.launch / meta / failed");
    expect(html).toContain("Public publish");
    expect(html).toContain("Reply / DM");
    expect(html).toContain("Sales send");
    expect(html).toContain("Paid spend");
    expect(html).toContain("Review approval approval_public");
    expect(html).toContain("Approve approval_public");
    expect(html).toContain("Reject approval_public");
    expect(html).toContain("Launch post draft");
    expect(html).toContain("paid_spend_or_boost");
    expect(html).toContain("CEO report");
    expect(html).toContain("Memory log");
    expect(html).toContain("mission loops");
    expect(html).toContain("Viral trend research loop");
    expect(html).toContain("Analytics feedback loop");
    expect(html).toContain("Publishing schedule");
    expect(html).toContain("inbox ingestion");
    expect(html).toContain("Inbox ingestion loop");
    expect(html).toContain("inbox evidence");
    expect(html).toContain("1 conversations");
    expect(html).toContain("1 inbound");
    expect(html).toContain("1 reply drafts");
    expect(html).toContain("Buyer Ops / buyer_ops / engaged");
    expect(html).toContain("comment / inbound / 2026-06-04T00:10:00.000Z");
    expect(html).toContain("Can Trent publish clips for us?");
    expect(html).toContain("draft_1 / approved / comment_or_dm_reply");
    expect(html).toContain("Approved reply");
    expect(html).toContain("Human approval dashboard");
    expect(html).toContain("creative assets");
    expect(html).toContain("Higgsfield sandbox creative asset");
    expect(html).toContain("HyperFrames sandbox creative asset");
    expect(html).toContain("Open Generative AI sandbox creative asset");
    expect(html).toContain("executions");
    expect(html).toContain("publishing calendar");
    expect(html).toContain("calendar post post_1");
    expect(html).toContain("Approved launch post");
    expect(html).toContain("scheduled for 2026-06-04T17:00:00.000Z");
    expect(html).toContain("external post ext_post_123");
    expect(html).toContain("media 1 / https://cdn.higgsfield.test/launch.mp4");
    expect(html).toContain("creative source higgsfield");
    expect(html).toContain("job_publish / completed / social.publish / Social:Instagram / post_1");
    expect(html).toContain("ad creative variants");
    expect(html).toContain("campaign campaign_1 / meta / draft");
    expect(html).toContain("higgsfield-video / approved / approved");
    expect(html).toContain("external creative sandbox_meta_creative_123");
    expect(html).toContain("platform failures");
    expect(html).toContain("1 failures");
    expect(html).toContain("1 manual review");
    expect(html).toContain("0 recoverable");
    expect(html).toContain("0 rate limited");
    expect(html).toContain("job_1 / failed / ads.launch / Ads:Meta / campaign_1");
    expect(html).toContain("rejected_creative / rejected_ad_creative / not recoverable");
    expect(html).toContain("Meta Graph createCreative failed: Ad creative was rejected by policy review");
    expect(html).toContain("Revise the creative/content and resubmit for approval before retrying.");
    expect(html).toContain("post_1");
    expect(html).toContain("draft_1");
    expect(html).toContain("campaign_1");
    expect(html).toContain("provider actions");
    expect(html).toContain("ads.launch");
    expect(html).toContain("Ads:Meta");
    expect(html).toContain("performance feedback");
    expect(html).toContain("social analytics");
    expect(html).toContain("snapshot_1 / instagram / 2026-06-04T00:00:00.000Z -&gt; 2026-06-05T00:00:00.000Z / Repurpose the proof demo.");
    expect(html).toContain("ad optimization");
    expect(html).toContain("opt_1 / completed / 2026-06-05 / scale_winner - CPA is inside the guardrail.");
    expect(html).toContain("feedback memory");
    expect(html).toContain("Content performance feedback 2026-06-05 / content-performance-feedback");
    expect(html).toContain("next recommendations");
    expect(html).toContain("Meta campaign AgentMission amr_1: CPA is inside the guardrail.");
    expect(html).toContain("platform readiness");
    expect(html).toContain("required social");
    expect(html).toContain("tiktok");
    expect(html).toContain("required ads");
    expect(html).toContain("meta");
    expect(html).toContain("creative apps");
    expect(html).toContain("higgsfield");
    expect(html).toContain("higgsfield creative credentials are missing");
    expect(html).toContain("tiktok social credentials are missing");
    expect(html).toContain("meta ads credentials are missing");
    expect(html).toContain("social connections");
    expect(html).toContain("Social:TikTok");
    expect(html).toContain("needs_credentials");
    expect(html).toContain("post:write");
    expect(html).toContain("connection actions");
    expect(html).toContain("Connect Social:TikTok");
    expect(html).toContain("Connect Higgsfield");
    expect(html).toContain("data-platform=\"tiktok\"");
    expect(html).toContain("data-app=\"higgsfield\"");
    expect(html).toContain("ads connections");
    expect(html).toContain("Ads:Meta");
    expect(html).toContain("ads:read");
    expect(html).toContain("approval_requested");
    expect(html).toContain("CEO Mission Report");
  });
});
