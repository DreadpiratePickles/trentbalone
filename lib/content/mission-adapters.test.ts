import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCreativeGenerationAdapter,
  createSocialPlatformAdapter,
  createAdsPlatformAdapter,
  createEngagementAdapter,
} from "@/lib/content/mission-adapters";

const BASE = { companyId: "co_1", runId: "amr_1" };

afterEach(() => {
  delete process.env.HIGGSFIELD_API_KEY;
});

describe("creative generation adapter", () => {
  const adapter = createCreativeGenerationAdapter();

  it("creates a video brief draft without approval and stores an artifact", async () => {
    const result = await adapter.createVideoBrief({ ...BASE, prompt: "Launch teaser", seat: "content" });
    expect(result.status).toBe("draft");
    expect(result.artifact?.createdByAgent).toBe("content");
    expect(result.artifact?.content).toContain("Launch teaser");
  });

  it("returns needs_credentials when generating video without HIGGSFIELD_API_KEY", async () => {
    const result = await adapter.generateVideoAsset({ ...BASE, prompt: "Launch teaser", seat: "growth" });
    expect(result.status).toBe("needs_credentials");
    expect(result.detail).toContain("HIGGSFIELD_API_KEY");
  });

  it("drafts a generated video asset when the key is present without publishing it", async () => {
    process.env.HIGGSFIELD_API_KEY = "hf_test";
    const higgsfield = vi.fn(async () => ({
      providerJobId: "hf_job_1",
      status: "pending" as const,
      videoUrl: "https://cdn.higgsfield.test/video.mp4",
    }));
    const result = await createCreativeGenerationAdapter({ higgsfield })
      .generateVideoAsset({ ...BASE, prompt: "Launch teaser", seat: "growth" });

    expect(result.status).toBe("draft");
    expect(result.externalRef).toBe("hf_job_1");
    expect(result.artifact?.createdByAgent).toBe("growth");
    expect(result.artifact?.content).toContain("https://cdn.higgsfield.test/video.mp4");
    expect(higgsfield).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "co_1",
      prompt: "Launch teaser",
    }));
  });

  it("blocks video generation with detailed failure when Higgsfield rejects the request", async () => {
    process.env.HIGGSFIELD_API_KEY = "hf_test";
    const result = await createCreativeGenerationAdapter({
      higgsfield: vi.fn(async () => {
        throw new Error("Higgsfield HTTP 429: rate limited");
      }),
    }).generateVideoAsset({ ...BASE, prompt: "Launch teaser", seat: "growth" });

    expect(result.status).toBe("blocked");
    expect(result.detail).toContain("rate limited");
  });
});

describe("social platform mission adapter", () => {
  const adapter = createSocialPlatformAdapter();

  it("creates a post draft without approval", async () => {
    const result = await adapter.createDraftPost({ ...BASE, platform: "tiktok", content: "hi" });
    expect(result.status).toBe("draft");
    expect(result.artifact).toBeTruthy();
  });

  it("requires approval to publish a post when no approval id is supplied", async () => {
    const result = await adapter.publishApprovedPost({ ...BASE, platform: "tiktok", content: "hi" });
    expect(result.status).toBe("needs_approval");
    expect(result.gate).toBe("public_publish");
  });

  it("publishes the post and logs an artifact and event with an approval id", async () => {
    const result = await adapter.publishApprovedPost({ ...BASE, platform: "tiktok", content: "hi", approvalId: "ap_1" });
    expect(result.status).toBe("executed");
    expect(result.externalRef).toBeTruthy();
    expect(result.artifact).toBeTruthy();
    expect(result.event?.kind).toBe("artifact_created");
  });

  it("requires approval to send a reply", async () => {
    const result = await adapter.sendApprovedReply({ ...BASE, platform: "tiktok", threadId: "t1", content: "thanks" });
    expect(result.status).toBe("needs_approval");
    expect(result.gate).toBe("comment_or_dm_reply");
  });
});

describe("ads platform mission adapter", () => {
  const adapter = createAdsPlatformAdapter();

  it("drafts a campaign without approval", async () => {
    const result = await adapter.createCampaignDraft({ ...BASE, platform: "meta", objective: "leads", budgetCents: 5000 });
    expect(result.status).toBe("draft");
  });

  it("estimates spend as a read action without approval", async () => {
    const result = await adapter.estimateSpend({ ...BASE, platform: "meta", budgetCents: 5000 });
    expect(result.status).toBe("draft");
    expect(result.detail).toContain("5000");
  });

  it("requires approval to launch a campaign", async () => {
    const result = await adapter.launchApprovedCampaign({ ...BASE, platform: "meta", campaignId: "c1", budgetCents: 5000 });
    expect(result.status).toBe("needs_approval");
    expect(result.gate).toBe("paid_spend_or_boost");
  });

  it("launches the campaign with an approval id", async () => {
    const result = await adapter.launchApprovedCampaign({ ...BASE, platform: "meta", campaignId: "c1", budgetCents: 5000, approvalId: "ap_2" });
    expect(result.status).toBe("executed");
    expect(result.externalRef).toBeTruthy();
  });
});

describe("engagement mission adapter", () => {
  const adapter = createEngagementAdapter();

  it("drafts a reply without approval", async () => {
    const result = await adapter.draftReply({ ...BASE, platform: "tiktok", threadId: "t1", content: "hello" });
    expect(result.status).toBe("draft");
  });

  it("requires approval to send a reply", async () => {
    const result = await adapter.sendApprovedReply({ ...BASE, platform: "tiktok", threadId: "t1", content: "hello" });
    expect(result.status).toBe("needs_approval");
    expect(result.gate).toBe("comment_or_dm_reply");
  });

  it("routes a lead to sales as a draft without approval", async () => {
    const result = await adapter.routeLead({ ...BASE, contactId: "ct1", reason: "interested buyer" });
    expect(result.status).toBe("draft");
    expect(result.artifact?.createdByAgent).toBe("sales");
  });
});
