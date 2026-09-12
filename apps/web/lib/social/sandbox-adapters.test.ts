import { describe, expect, it } from "vitest";
import { SOCIAL_PLATFORMS } from "./platform-adapter";
import {
  createSandboxSocialAdapter,
  getSandboxSocialPlatformAdapter,
} from "./sandbox-adapters";

describe("sandbox social adapters", () => {
  it("returns deterministic post draft and publish refs without network inputs", async () => {
    const adapter = createSandboxSocialAdapter("instagram");

    const draft = await adapter.createPostDraft({
      companyId: "co_1",
      socialAccountId: "sa_1",
      externalAccountId: "ig_business_1",
      content: "Launch Alpha!",
      mediaUrls: ["https://cdn.example.test/a.png"],
      scheduledFor: "2026-05-29T12:00:00Z",
    });
    const repeat = await adapter.createPostDraft({
      companyId: "co_1",
      socialAccountId: "sa_1",
      externalAccountId: "ig_business_1",
      content: "Launch Alpha!",
      mediaUrls: ["https://cdn.example.test/a.png"],
      scheduledFor: "2026-05-29T12:00:00Z",
    });

    expect(draft).toEqual(repeat);
    expect(draft).toEqual({
      platform: "instagram",
      externalDraftId: "sandbox_instagram_draft_co_1_sa_1_launch_alpha",
      status: "draft",
    });

    await expect(adapter.publishPost({
      companyId: "co_1",
      socialAccountId: "sa_1",
      externalAccountId: "ig_business_1",
      postId: "sp_1",
      content: "Launch Alpha!",
      mediaUrls: ["https://cdn.example.test/a.png"],
    })).resolves.toEqual({
      platform: "instagram",
      externalPostId: "sandbox_instagram_post_co_1_sa_1_sp_1",
      status: "published",
      publishedAt: "2026-05-29T00:00:00.000Z",
    });
  });

  it("returns deterministic refs for replies, DMs, inbox, analytics, and moderation", async () => {
    const adapter = createSandboxSocialAdapter("x");

    await expect(adapter.reply({
      companyId: "co_1",
      socialAccountId: "sa_1",
      externalAccountId: "acct_1",
      externalThreadId: "thread_1",
      content: "Thanks for the mention.",
    })).resolves.toEqual({
      platform: "x",
      externalReplyId: "sandbox_x_reply_co_1_sa_1_thread_1",
      status: "sent",
    });

    await expect(adapter.sendDm({
      companyId: "co_1",
      socialAccountId: "sa_1",
      externalAccountId: "acct_1",
      externalContactId: "contact_1",
      content: "Want a preview?",
    })).resolves.toEqual({
      platform: "x",
      externalMessageId: "sandbox_x_dm_co_1_sa_1_contact_1",
      status: "sent",
    });

    await expect(adapter.fetchInbox({
      companyId: "co_1",
      socialAccountId: "sa_1",
      externalAccountId: "acct_1",
      since: "2026-05-28T00:00:00Z",
    })).resolves.toEqual({
      platform: "x",
      messages: [],
      nextCursor: undefined,
      status: "sandbox",
    });

    await expect(adapter.fetchAnalytics({
      companyId: "co_1",
      socialAccountId: "sa_1",
      externalAccountId: "acct_1",
      externalPostId: "post_1",
      since: "2026-05-28T00:00:00Z",
      until: "2026-05-29T00:00:00Z",
    })).resolves.toEqual({
      platform: "x",
      impressions: 0,
      engagements: 0,
      clicks: 0,
      followersDelta: 0,
      videoViews: 0,
    });

    await expect(adapter.deleteOrHideContent({
      companyId: "co_1",
      socialAccountId: "sa_1",
      externalAccountId: "acct_1",
      externalContentId: "post_1",
      action: "hide",
      reason: "spam",
    })).resolves.toEqual({
      platform: "x",
      externalContentId: "post_1",
      action: "hide",
      status: "sandbox",
    });
  });

  it("registers a sandbox adapter for every supported social platform", () => {
    for (const platform of SOCIAL_PLATFORMS) {
      const adapter = getSandboxSocialPlatformAdapter(platform);

      expect(adapter.platform).toBe(platform);
      expect(adapter.capabilities.posts).toBe(true);
      expect(adapter.capabilities.replies).toBe(true);
      expect(adapter.capabilities.dms).toBe(true);
      expect(adapter.capabilities.inbox).toBe(true);
      expect(adapter.capabilities.analytics).toBe(true);
      expect(adapter.capabilities.moderationActions).toBe(true);
    }
  });
});
