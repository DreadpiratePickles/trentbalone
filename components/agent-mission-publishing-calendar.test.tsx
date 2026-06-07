import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentMissionPublishingCalendar } from "@/components/agent-mission-publishing-calendar";

describe("AgentMissionPublishingCalendar", () => {
  it("renders scheduled posts, media URLs, ad creative variants, and provider proof", () => {
    const html = renderToStaticMarkup(
      <AgentMissionPublishingCalendar
        posts={[
          {
            id: "post_1",
            platform: "tiktok",
            status: "scheduled",
            approvalId: "approval_public",
            content: "Launch clip",
            scheduledFor: "2026-06-04T17:00:00.000Z",
            mediaUrls: ["https://cdn.higgsfield.test/launch.mp4"],
            metadata: { creativeAssetSource: "higgsfield" },
          },
        ]}
        adCampaigns={[
          {
            id: "campaign_1",
            platform: "meta",
            status: "draft",
            approvalId: "approval_ads",
            name: "AgentMission amr_1",
          },
        ]}
        adCreativeVariants={[
          {
            id: "creative_1",
            campaignId: "campaign_1",
            variantKey: "higgsfield-video",
            assetUrl: "https://cdn.higgsfield.test/launch.mp4",
            moderationStatus: "approved",
            brandSafetyStatus: "approved",
            externalCreativeId: "sandbox_meta_creative_123",
            headline: "See Trent ship the launch",
          },
        ]}
        providerActions={[
          {
            id: "job_publish",
            type: "platform_action",
            status: "completed",
            summary: "[Simulated] Completed platform action: social.publish tiktok",
            metadata: {
              action: "social.publish",
              provider: "Social:TikTok",
              targetId: "post_1",
              executionMode: "sandbox",
              result: {
                externalRef: "sandbox_tiktok_post_post_1",
                executionMode: "sandbox",
              },
            },
          },
          {
            id: "job_ads",
            type: "platform_action",
            status: "completed",
            summary: "[Simulated] Completed platform action: ads.launch meta",
            metadata: {
              action: "ads.launch",
              provider: "Ads:Meta",
              targetId: "campaign_1",
              executionMode: "sandbox",
              result: {
                externalCreativeId: "sandbox_meta_creative_123",
                assetUrl: "https://cdn.higgsfield.test/launch.mp4",
                externalRef: "sandbox_meta_campaign_campaign_1",
                executionMode: "sandbox",
              },
            },
          },
        ]}
      />,
    );

    expect(html).toContain("publishing calendar");
    expect(html).toContain("calendar post post_1");
    expect(html).toContain("tiktok / scheduled");
    expect(html).toContain("media 1");
    expect(html).toContain("https://cdn.higgsfield.test/launch.mp4");
    expect(html).toContain("creative source higgsfield");
    expect(html).toContain("job_publish / completed / social.publish / Social:TikTok / post_1");
    expect(html).toContain("[Simulated]");
    expect(html).toContain("Simulated (sandbox)");
    expect(html).toContain("ad creative variants");
    expect(html).toContain("campaign campaign_1 / meta / draft");
    expect(html).toContain("higgsfield-video / approved / approved");
    expect(html).toContain("external creative sandbox_meta_creative_123");
    expect(html).toContain("job_ads / completed / ads.launch / Ads:Meta / campaign_1");
  });
});
