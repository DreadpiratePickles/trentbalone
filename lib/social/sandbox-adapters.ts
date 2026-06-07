import type {
  SocialAnalytics,
  SocialAnalyticsInput,
  SocialDmInput,
  SocialDmResult,
  SocialInboxInput,
  SocialInboxResult,
  SocialModerationInput,
  SocialModerationResult,
  SocialPlatform,
  SocialPlatformAdapter,
  SocialPlatformCapabilities,
  SocialPostDraft,
  SocialPostDraftInput,
  SocialPublishPostInput,
  SocialPublishedPost,
  SocialReplyInput,
  SocialReplyResult,
} from "./platform-adapter";

const SANDBOX_PUBLISHED_AT = "2026-05-29T00:00:00.000Z";

const BASE_SANDBOX_CAPABILITIES = {
  posts: true,
  replies: true,
  dms: true,
  inbox: true,
  analytics: true,
  videoUpload: false,
  storiesReels: false,
  communityPosts: false,
  moderationActions: true,
} satisfies SocialPlatformCapabilities;

const PLATFORM_CAPABILITY_OVERRIDES: Partial<Record<SocialPlatform, Partial<SocialPlatformCapabilities>>> = {
  x: { videoUpload: true, communityPosts: true },
  instagram: { videoUpload: true, storiesReels: true },
  facebook: { videoUpload: true, storiesReels: true, communityPosts: true },
  linkedin: { videoUpload: true, communityPosts: true },
  tiktok: { videoUpload: true },
  youtube: { videoUpload: true, communityPosts: true },
  threads: { videoUpload: true },
  bluesky: {},
  mastodon: {},
};

export function getSandboxSocialPlatformAdapter(platform: SocialPlatform): SocialPlatformAdapter {
  return createSandboxSocialAdapter(platform);
}

export function createSandboxSocialAdapter(platform: SocialPlatform): SocialPlatformAdapter {
  return {
    platform,
    capabilities: sandboxCapabilities(platform),

    async createPostDraft(input: SocialPostDraftInput): Promise<SocialPostDraft> {
      requireText(input.content, "content");
      return {
        platform,
        externalDraftId: sandboxRef(platform, "draft", input.companyId, input.socialAccountId, input.content),
        status: "draft",
      };
    },

    async publishPost(input: SocialPublishPostInput): Promise<SocialPublishedPost> {
      requireText(input.postId, "postId");
      return {
        platform,
        externalPostId: sandboxRef(platform, "post", input.companyId, input.socialAccountId, input.postId),
        status: "published",
        publishedAt: SANDBOX_PUBLISHED_AT,
      };
    },

    async reply(input: SocialReplyInput): Promise<SocialReplyResult> {
      requireText(input.externalThreadId, "externalThreadId");
      return {
        platform,
        externalReplyId: sandboxRef(platform, "reply", input.companyId, input.socialAccountId, input.externalThreadId),
        status: "sent",
      };
    },

    async sendDm(input: SocialDmInput): Promise<SocialDmResult> {
      requireText(input.externalContactId, "externalContactId");
      return {
        platform,
        externalMessageId: sandboxRef(platform, "dm", input.companyId, input.socialAccountId, input.externalContactId),
        status: "sent",
      };
    },

    async fetchInbox(input: SocialInboxInput): Promise<SocialInboxResult> {
      requireText(input.externalAccountId, "externalAccountId");
      return {
        platform,
        messages: [],
        nextCursor: undefined,
        status: "sandbox",
      };
    },

    async fetchAnalytics(input: SocialAnalyticsInput): Promise<SocialAnalytics> {
      requireText(input.externalAccountId, "externalAccountId");
      return {
        platform,
        impressions: 0,
        engagements: 0,
        clicks: 0,
        followersDelta: 0,
        videoViews: 0,
      };
    },

    async deleteOrHideContent(input: SocialModerationInput): Promise<SocialModerationResult> {
      requireText(input.externalContentId, "externalContentId");
      return {
        platform,
        externalContentId: input.externalContentId,
        action: input.action,
        status: "sandbox",
      };
    },
  };
}

function sandboxCapabilities(platform: SocialPlatform): SocialPlatformCapabilities {
  return {
    ...BASE_SANDBOX_CAPABILITIES,
    ...(PLATFORM_CAPABILITY_OVERRIDES[platform] ?? {}),
  };
}

function sandboxRef(
  platform: SocialPlatform,
  kind: string,
  companyId: string,
  socialAccountId: string,
  source: string
) {
  return `sandbox_${platform}_${kind}_${companyId}_${socialAccountId}_${slugify(source)}`;
}

function slugify(value: string) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "item";
}

function requireText(value: string, field: string) {
  if (!value.trim()) throw new Error(`${field} is required`);
}
