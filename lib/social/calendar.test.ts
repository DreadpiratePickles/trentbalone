import { describe, expect, it, vi } from "vitest";
import {
  adaptPostForPlatform,
  assertPublishingAllowed,
  createPublishingApproval,
  createSocialCalendarPosts,
  type SocialAccount,
  type SocialPost,
} from "./calendar";

describe("social content calendar", () => {
  it("adapts a base post for each selected platform", () => {
    const xPost = adaptPostForPlatform({
      platform: "x",
      content: "Launch week update ".repeat(20),
      mediaUrls: ["https://cdn.example.com/launch.png", "https://cdn.example.com/demo.mp4"],
    });
    const linkedinPost = adaptPostForPlatform({
      platform: "linkedin",
      content: "Founder update",
      mediaUrls: ["https://cdn.example.com/launch.png"],
    });

    expect(xPost.platform).toBe("x");
    expect(xPost.content.length).toBeLessThanOrEqual(280);
    expect(xPost.mediaUrls).toEqual(["https://cdn.example.com/launch.png"]);
    expect(linkedinPost.content).toContain("Founder update");
    expect(linkedinPost.mediaUrls).toEqual(["https://cdn.example.com/launch.png"]);
  });

  it("creates one platform-specific draft per selected account and never publishes scheduled posts directly", async () => {
    const createSocialPost = vi.fn(async (input) => ({
      ...input,
      id: `post_${input.platform}`,
      status: input.status,
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:00.000Z",
    }));
    const createApproval = vi.fn(async (input) => ({
      ...input,
      id: `approval_${input.action}`,
      status: "pending",
      createdAt: "2026-05-29T00:00:00.000Z",
    }));
    const updateSocialPost = vi.fn(async (id, patch) => ({
      ...createSocialPost.mock.results.find(Boolean)?.value,
      id,
      companyId: "co_1",
      socialAccountId: id === "post_x" ? "acct_x" : "acct_linkedin",
      platform: id === "post_x" ? "x" : "linkedin",
      status: "queued",
      content: "Launch week update for Trent",
      mediaUrls: ["https://cdn.example.com/launch.png"],
      scheduledFor: "2026-06-01T14:00:00.000Z",
      metadata: {},
      ...patch,
    }));

    const result = await createSocialCalendarPosts({
      store: { createSocialPost, createApproval, updateSocialPost },
      companyId: "co_1",
      accounts: [
        account({ id: "acct_x", platform: "x" }),
        account({ id: "acct_linkedin", platform: "linkedin" }),
      ],
      content: "Launch week update for Trent",
      mediaUrls: ["https://cdn.example.com/launch.png"],
      scheduledFor: "2026-06-01T14:00:00.000Z",
    });

    expect(createSocialPost).toHaveBeenCalledTimes(2);
    expect(createSocialPost).toHaveBeenNthCalledWith(1, expect.objectContaining({
      socialAccountId: "acct_x",
      platform: "x",
      status: "queued",
      publishedAt: undefined,
      externalPostId: undefined,
    }));
    expect(createSocialPost).toHaveBeenNthCalledWith(2, expect.objectContaining({
      socialAccountId: "acct_linkedin",
      platform: "linkedin",
      status: "queued",
    }));
    expect(result.posts).toHaveLength(2);
    expect(result.posts[0]?.approvalId).toBe("approval_publish_social_post");
    expect(result.approvals).toHaveLength(2);
    expect(createApproval).toHaveBeenCalledTimes(2);
    expect(updateSocialPost).toHaveBeenCalledTimes(2);
  });

  it("creates approval previews as post previews with platform, content, and media summary", async () => {
    const createApproval = vi.fn(async (input) => ({
      ...input,
      id: "approval_post",
      status: "pending",
      createdAt: "2026-05-29T00:00:00.000Z",
    }));

    const approval = await createPublishingApproval({
      store: { createApproval },
      post: post({
        platform: "instagram",
        content: "New founder operating rhythm",
        mediaUrls: ["https://cdn.example.com/post.png"],
      }),
    });

    expect(createApproval).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "co_1",
      action: "publish_social_post",
      previewKind: "post",
    }));
    expect(approval.previewKind).toBe("post");
    expect(approval.previewContent).toContain("instagram");
    expect(approval.previewContent).toContain("New founder operating rhythm");
    expect(approval.previewContent).toContain("1 media item");
  });

  it("requires an approved approval record and an auto-publish-enabled account before publishing", async () => {
    await expect(assertPublishingAllowed({
      post: post({ approvalId: "approval_1" }),
      account: account({ autoPublishEnabled: true }),
      approval: { id: "approval_1", companyId: "co_1", status: "pending" },
    })).rejects.toThrow("approved approval");

    await expect(assertPublishingAllowed({
      post: post({ approvalId: "approval_1" }),
      account: account({ autoPublishEnabled: false }),
      approval: { id: "approval_1", companyId: "co_1", status: "approved" },
    })).rejects.toThrow("Auto-publish is disabled");

    await expect(assertPublishingAllowed({
      post: post({ approvalId: "approval_1" }),
      account: account({ autoPublishEnabled: true }),
      approval: { id: "approval_1", companyId: "co_1", status: "approved" },
    })).resolves.toBeUndefined();
  });
});

function account(overrides: Partial<SocialAccount> = {}): SocialAccount {
  return {
    id: "acct_1",
    companyId: "co_1",
    platform: "x",
    status: "active",
    externalAccountId: "external_1",
    externalHandle: "@trent",
    displayName: "Trent",
    scopes: [],
    autoPublishEnabled: false,
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:00.000Z",
    ...overrides,
  };
}

function post(overrides: Partial<SocialPost> = {}): SocialPost {
  return {
    id: "post_1",
    companyId: "co_1",
    socialAccountId: "acct_1",
    platform: "x",
    status: "queued",
    content: "Launch week update",
    mediaUrls: [],
    scheduledFor: "2026-06-01T14:00:00.000Z",
    approvalId: "approval_1",
    metadata: {},
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:00.000Z",
    ...overrides,
  };
}
