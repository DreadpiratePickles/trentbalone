import { afterEach, describe, expect, it, vi } from "vitest";
import { syncAgentMissionForApproval } from "@/lib/agent-mission-approval-hook";
import { runAgentMission } from "@/lib/agent-mission-runtime";
import { saveCreativeConnection } from "@/lib/creative-connections";
import { saveMarketingPlatformConnection } from "@/lib/platform-connections";
import { store } from "@/lib/store";
import { makeId } from "@/lib/utils";

describe("agent mission ads creative media handoff", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("attaches generated Higgsfield video to approved Meta ad launch actions", async () => {
    vi.stubEnv("HIGGSFIELD_GENERATION_MODE", "live");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      job_id: "hf_job_meta_ad_1",
      status: "succeeded",
      video_url: "https://cdn.higgsfield.test/meta-ad.mp4",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const company = await store.createCompany({ name: `MissionAdsMedia ${makeId("co")}`, brief: { vision: "test" } });
    await saveCreativeConnection(company.id, { app: "higgsfield", apiKey: "higgs_live_123456789" });
    await saveMarketingPlatformConnection(company.id, {
      platform: "meta",
      accessToken: "meta_token_123456789",
      externalAccountId: "act_meta_media",
      dailyBudgetCents: 2500,
      paymentStatus: "ready",
    });

    const mission = await runAgentMission({
      companyId: company.id,
      objective: "Create a Higgsfield launch video and launch Meta ads using that generated video creative.",
      trigger: "command",
      budgetCents: 7500,
    });
    const approval = mission.approvals.find((item) => item.action === "agent_mission.paid_spend_or_boost");
    const resolved = await store.resolveApproval(approval?.id ?? "missing", "approved");

    await syncAgentMissionForApproval(resolved!);

    const campaign = (await store.listAdCampaigns(company.id)).find((item) =>
      item.approvalId === approval?.id
    );
    expect(campaign).toBeDefined();
    const variants = await store.listAdCreativeVariants(company.id, campaign?.id);
    expect(variants).toEqual([
      expect.objectContaining({
        variantKey: "higgsfield-video",
        assetUrl: "https://cdn.higgsfield.test/meta-ad.mp4",
        moderationStatus: "approved",
        brandSafetyStatus: "approved",
        metrics: expect.objectContaining({
          source: "higgsfield",
          providerJobId: "hf_job_meta_ad_1",
          missionRunId: mission.run.id,
        }),
      }),
    ]);

    const providerActions = (await store.listJobRuns(company.id)).filter((job) =>
      job.type === "platform_action" && job.metadata.runId === mission.run.id
    );
    expect(providerActions).toEqual([
      expect.objectContaining({
        status: "completed",
        metadata: expect.objectContaining({
          action: "ads.launch",
          payload: expect.objectContaining({
            creativeVariantId: variants[0].id,
            assetUrl: "https://cdn.higgsfield.test/meta-ad.mp4",
            creativeAssetSource: "higgsfield",
          }),
          result: expect.objectContaining({
            externalCreativeId: expect.stringContaining("sandbox_meta_creative"),
            assetUrl: "https://cdn.higgsfield.test/meta-ad.mp4",
          }),
        }),
      }),
    ]);
  });
});
