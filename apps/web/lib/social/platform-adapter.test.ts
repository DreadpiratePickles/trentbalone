import { describe, expect, it, vi } from "vitest";
import {
  REQUIRED_SOCIAL_ADAPTER_METHODS,
  SOCIAL_PLATFORM_CAPABILITY_KEYS,
  SOCIAL_PLATFORMS,
  SocialPlatformApiError,
  createLiveSocialAdapter,
  getSocialPlatformAdapter,
  isSocialPlatform,
  type SocialPlatformAdapter,
} from "./platform-adapter";

describe("SocialPlatformAdapter contract", () => {
  it("defines every supported Phase 7 social platform", () => {
    expect(SOCIAL_PLATFORMS).toEqual([
      "x",
      "instagram",
      "facebook",
      "linkedin",
      "tiktok",
      "youtube",
      "threads",
      "bluesky",
      "mastodon",
    ]);
    expect(isSocialPlatform("x")).toBe(true);
    expect(isSocialPlatform("twitter")).toBe(false);
  });

  it("requires the complete social adapter method surface", () => {
    expect(REQUIRED_SOCIAL_ADAPTER_METHODS).toEqual([
      "createPostDraft",
      "publishPost",
      "reply",
      "sendDm",
      "fetchInbox",
      "fetchAnalytics",
      "deleteOrHideContent",
    ]);
  });

  it("exposes explicit capability flags for posting, engagement, media, and moderation", () => {
    const adapter: SocialPlatformAdapter = {
      platform: "x",
      capabilities: {
        posts: true,
        replies: true,
        dms: true,
        inbox: true,
        analytics: true,
        videoUpload: true,
        storiesReels: false,
        communityPosts: false,
        moderationActions: true,
      },
      createPostDraft: vi.fn(),
      publishPost: vi.fn(),
      reply: vi.fn(),
      sendDm: vi.fn(),
      fetchInbox: vi.fn(),
      fetchAnalytics: vi.fn(),
      deleteOrHideContent: vi.fn(),
    };

    expect(Object.keys(adapter.capabilities)).toEqual(SOCIAL_PLATFORM_CAPABILITY_KEYS);
  });

  it("returns live adapters for connected first-party platforms and fails closed for unsupported long-tail platforms", async () => {
    for (const platform of ["threads", "bluesky", "mastodon"] as const) {
      const adapter = getSocialPlatformAdapter(platform);

      expect(adapter.platform).toBe(platform);
      expect(Object.keys(adapter.capabilities)).toEqual(SOCIAL_PLATFORM_CAPABILITY_KEYS);
      expect(adapter.capabilities.posts).toBe(false);

      await expect(adapter.publishPost({
        companyId: "co_1",
        socialAccountId: "sa_1",
        externalAccountId: "acct_1",
        postId: "sp_1",
        content: "Launch note",
        mediaUrls: [],
      })).rejects.toThrow(`Live ${platform} publishPost is not implemented`);
    }
  });

  it("publishes an X post through the v2 tweet endpoint", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const adapter = createLiveSocialAdapter("x", {
      tokenResolver: async () => ({ accessToken: "x_token", externalAccountId: "user_1" }),
      httpFetch: async (url, init) => {
        calls.push({ url, init });
        return jsonResponse({ data: { id: "tweet_1" } });
      },
      now: () => "2026-06-06T12:00:00.000Z",
    });

    const result = await adapter.publishPost({
      companyId: "co_1",
      socialAccountId: "soc_1",
      externalAccountId: "user_1",
      postId: "post_1",
      content: "Launch note",
    });

    expect(result.externalPostId).toBe("tweet_1");
    expect(result.publishedAt).toBe("2026-06-06T12:00:00.000Z");
    expect(calls[0]?.url).toBe("https://api.x.com/2/tweets");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ text: "Launch note" });
  });

  it("publishes Instagram media with the required create-container then publish flow", async () => {
    const calls: string[] = [];
    const adapter = createLiveSocialAdapter("instagram", {
      tokenResolver: async () => ({ accessToken: "ig_token", externalAccountId: "ig_1" }),
      httpFetch: async (url) => {
        calls.push(url);
        return calls.length === 1
          ? jsonResponse({ id: "container_1" })
          : jsonResponse({ id: "ig_media_1" });
      },
      now: () => "2026-06-06T12:00:00.000Z",
    });

    const result = await adapter.publishPost({
      companyId: "co_1",
      socialAccountId: "soc_1",
      externalAccountId: "ig_1",
      postId: "post_1",
      content: "Launch reel",
      mediaUrls: ["https://cdn.example.com/video.mp4"],
    });

    expect(result.externalPostId).toBe("ig_media_1");
    expect(calls[0]).toContain("/ig_1/media");
    expect(calls[1]).toContain("/ig_1/media_publish");
  });

  it("classifies expired-token and rate-limit failures with typed provider errors", async () => {
    const expired = createLiveSocialAdapter("facebook", {
      tokenResolver: async () => ({ accessToken: "fb_token", externalAccountId: "page_1" }),
      httpFetch: async () => textResponse(401, "OAuth token expired"),
    });
    await expect(expired.publishPost({
      companyId: "co_1",
      socialAccountId: "soc_1",
      externalAccountId: "page_1",
      postId: "post_1",
      content: "Launch",
    })).rejects.toMatchObject({ code: "expired_token" });

    const limited = createLiveSocialAdapter("x", {
      tokenResolver: async () => ({ accessToken: "x_token", externalAccountId: "user_1" }),
      httpFetch: async () => textResponse(429, "Too many requests"),
    });
    await expect(limited.fetchInbox({
      companyId: "co_1",
      socialAccountId: "soc_1",
      externalAccountId: "user_1",
    })).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("normalizes analytics and inbox payloads", async () => {
    const adapter = createLiveSocialAdapter("x", {
      tokenResolver: async () => ({ accessToken: "x_token", externalAccountId: "user_1" }),
      httpFetch: async (url) => {
        if (url.includes("/mentions")) {
          return jsonResponse({
            data: [{
              id: "tweet_2",
              text: "Interested in Trent",
              author_id: "lead_1",
              conversation_id: "thread_1",
              created_at: "2026-06-06T12:00:00.000Z",
            }],
          });
        }
        return jsonResponse({
          data: {
            public_metrics: {
              impression_count: 100,
              like_count: 5,
              reply_count: 2,
              retweet_count: 1,
              quote_count: 1,
            },
          },
        });
      },
    });

    const inbox = await adapter.fetchInbox({
      companyId: "co_1",
      socialAccountId: "soc_1",
      externalAccountId: "user_1",
    });
    expect(inbox.messages[0]).toMatchObject({
      externalMessageId: "tweet_2",
      externalThreadId: "thread_1",
      externalContactId: "lead_1",
      kind: "mention",
    });

    const analytics = await adapter.fetchAnalytics({
      companyId: "co_1",
      socialAccountId: "soc_1",
      externalAccountId: "user_1",
      externalPostId: "tweet_1",
    });
    expect(analytics).toMatchObject({
      impressions: 100,
      engagements: 9,
      videoViews: 0,
    });
  });
});

function jsonResponse(data: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

function textResponse(status: number, body: string) {
  return {
    ok: false,
    status,
    json: async () => ({ error: body }),
    text: async () => body,
  };
}
