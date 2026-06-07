import { describe, expect, it } from "vitest";
import { AGENT_MISSION_E2E_FIXTURE_ID, buildAgentMissionE2EActuals } from "@/lib/agent-mission-e2e-eval";

describe("AgentMission e2e runtime actuals", () => {
  it("captures structured publish, reply, ad, approval, memory, and CEO report evidence", async () => {
    const actuals = await buildAgentMissionE2EActuals();
    const actual = actuals[AGENT_MISSION_E2E_FIXTURE_ID];

    expect(actual.toolCalls).toEqual(["agent_mission.run"]);
    expect(actual.text).toContain("CEO Mission Report");
    expect(actual.text).toContain("provider_action_executed");
    expect(actual.text).toContain("social.publish");
    expect(actual.text).toContain("ads.launch");
    expect(actual.text).toContain("social_inbox_ingested");
    expect(actual.text).toContain("content_performance_feedback_ingested");
    expect(actual.text).toContain("memory-log.md");
    expect(actual.state).toEqual(expect.objectContaining({
      runStatus: "completed",
      approvalGates: expect.arrayContaining([
        "public_publish",
        "comment_or_dm_reply",
        "email_or_sales_send",
        "paid_spend_or_boost",
      ]),
      providerActionKinds: expect.arrayContaining(["social.publish", "social.reply", "sales.outreach_send", "ads.launch"]),
      providerActionStatuses: expect.arrayContaining(["completed"]),
      inboxImportedMessages: 1,
      runtimeInboxImportedMessages: 1,
      manualInboxImportedMessages: 0,
      runtimePerformanceFeedbackJobs: 1,
      manualPerformanceFeedbackIngestions: 0,
      performanceFeedbackStatus: "completed",
      performanceRecommendations: expect.arrayContaining([
        expect.stringContaining("Meta campaign"),
      ]),
      socialCalendar: expect.arrayContaining([
        expect.objectContaining({
          platform: "x",
          status: "published",
          mediaUrls: ["https://cdn.higgsfield.test/eval-video.mp4"],
          creativeAssetSource: "higgsfield",
        }),
      ]),
      adCampaigns: expect.arrayContaining([
        expect.objectContaining({ platform: "meta", status: "draft", hasExternalCampaignId: true }),
      ]),
      adCreativeVariants: expect.arrayContaining([
        expect.objectContaining({
          platform: "meta",
          variantKey: "higgsfield-video",
          assetUrl: "https://cdn.higgsfield.test/eval-video.mp4",
          hasExternalCreativeId: true,
        }),
      ]),
      memoryLogRefreshed: true,
      ceoSummaryIncludesNextAction: true,
    }));
  });
});
