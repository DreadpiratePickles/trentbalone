import { createLiveSocialAdapter, isLiveSocialPlatform } from "./live-platform-adapter";

export const SOCIAL_PLATFORMS = [
  "x",
  "instagram",
  "facebook",
  "linkedin",
  "tiktok",
  "youtube",
  "threads",
  "bluesky",
  "mastodon",
] as const;

export type SocialPlatform = typeof SOCIAL_PLATFORMS[number];

export const SOCIAL_PLATFORM_CAPABILITY_KEYS = [
  "posts",
  "replies",
  "dms",
  "inbox",
  "analytics",
  "videoUpload",
  "storiesReels",
  "communityPosts",
  "moderationActions",
] as const;

export type SocialPlatformCapabilities = Record<typeof SOCIAL_PLATFORM_CAPABILITY_KEYS[number], boolean>;

export const REQUIRED_SOCIAL_ADAPTER_METHODS = [
  "createPostDraft",
  "publishPost",
  "reply",
  "sendDm",
  "fetchInbox",
  "fetchAnalytics",
  "deleteOrHideContent",
] as const;

export type SocialPostDraftInput = {
  companyId: string;
  socialAccountId: string;
  externalAccountId: string;
  content: string;
  mediaUrls?: string[];
  scheduledFor?: string;
  metadata?: Record<string, unknown>;
};

export type SocialPostDraft = {
  platform: SocialPlatform;
  externalDraftId: string;
  status: "draft";
};

export type SocialPublishPostInput = SocialPostDraftInput & {
  postId: string;
  externalDraftId?: string;
  approvalId?: string;
};

export type SocialPublishedPost = {
  platform: SocialPlatform;
  externalPostId: string;
  status: "published";
  publishedAt: string;
};

export type SocialReplyInput = {
  companyId: string;
  socialAccountId: string;
  externalAccountId: string;
  externalThreadId: string;
  content: string;
  metadata?: Record<string, unknown>;
};

export type SocialReplyResult = {
  platform: SocialPlatform;
  externalReplyId: string;
  status: "sent";
};

export type SocialDmInput = {
  companyId: string;
  socialAccountId: string;
  externalAccountId: string;
  externalContactId: string;
  content: string;
  metadata?: Record<string, unknown>;
};

export type SocialDmResult = {
  platform: SocialPlatform;
  externalMessageId: string;
  status: "sent";
};

export type SocialInboxInput = {
  companyId: string;
  socialAccountId: string;
  externalAccountId: string;
  since?: string;
  cursor?: string;
  limit?: number;
};

export type SocialInboxMessage = {
  externalMessageId: string;
  externalThreadId: string;
  externalContactId: string;
  direction: "inbound" | "outbound";
  kind: "comment" | "dm" | "mention" | "reply";
  content: string;
  sentAt: string;
  metadata?: Record<string, unknown>;
};

export type SocialInboxResult = {
  platform: SocialPlatform;
  messages: SocialInboxMessage[];
  nextCursor?: string;
  status: "sandbox" | "fetched";
};

export type SocialAnalyticsInput = {
  companyId: string;
  socialAccountId: string;
  externalAccountId: string;
  externalPostId?: string;
  since?: string;
  until?: string;
};

export type SocialAnalytics = {
  platform: SocialPlatform;
  impressions: number;
  engagements: number;
  clicks: number;
  followersDelta: number;
  videoViews: number;
};

export type SocialModerationInput = {
  companyId: string;
  socialAccountId: string;
  externalAccountId: string;
  externalContentId: string;
  action: "delete" | "hide";
  reason: string;
  metadata?: Record<string, unknown>;
};

export type SocialModerationResult = {
  platform: SocialPlatform;
  externalContentId: string;
  action: "delete" | "hide";
  status: "sandbox" | "completed";
};

export type SocialPlatformErrorCode =
  | "needs_credentials"
  | "expired_token"
  | "rate_limited"
  | "rejected_content"
  | "partial_publication"
  | "unsupported_operation"
  | "provider_error";

export type SocialPlatformAdapter = {
  platform: SocialPlatform;
  capabilities: SocialPlatformCapabilities;
  createPostDraft(input: SocialPostDraftInput): Promise<SocialPostDraft>;
  publishPost(input: SocialPublishPostInput): Promise<SocialPublishedPost>;
  reply(input: SocialReplyInput): Promise<SocialReplyResult>;
  sendDm(input: SocialDmInput): Promise<SocialDmResult>;
  fetchInbox(input: SocialInboxInput): Promise<SocialInboxResult>;
  fetchAnalytics(input: SocialAnalyticsInput): Promise<SocialAnalytics>;
  deleteOrHideContent(input: SocialModerationInput): Promise<SocialModerationResult>;
};

export class SocialPlatformUnsupportedError extends Error {
  constructor(platform: SocialPlatform, operation: string) {
    super(
      `Live ${platform} ${operation} is not implemented; configure a sandbox adapter or add a provider implementation before enabling this feature.`
    );
    this.name = "SocialPlatformUnsupportedError";
  }
}

export const NO_LIVE_SOCIAL_CAPABILITIES: SocialPlatformCapabilities = {
  posts: false,
  replies: false,
  dms: false,
  inbox: false,
  analytics: false,
  videoUpload: false,
  storiesReels: false,
  communityPosts: false,
  moderationActions: false,
};

export { createLiveSocialAdapter, SocialPlatformApiError } from "./live-platform-adapter";

export function isSocialPlatform(value: unknown): value is SocialPlatform {
  return typeof value === "string" && SOCIAL_PLATFORMS.includes(value as SocialPlatform);
}

export function getSocialPlatformAdapter(platform: SocialPlatform): SocialPlatformAdapter {
  if (isLiveSocialPlatform(platform)) return createLiveSocialAdapter(platform);
  return createUnsupportedSocialAdapter(platform);
}

export function createUnsupportedSocialAdapter(platform: SocialPlatform): SocialPlatformAdapter {
  return {
    platform,
    capabilities: { ...NO_LIVE_SOCIAL_CAPABILITIES },
    createPostDraft: unsupported(platform, "createPostDraft"),
    publishPost: unsupported(platform, "publishPost"),
    reply: unsupported(platform, "reply"),
    sendDm: unsupported(platform, "sendDm"),
    fetchInbox: unsupported(platform, "fetchInbox"),
    fetchAnalytics: unsupported(platform, "fetchAnalytics"),
    deleteOrHideContent: unsupported(platform, "deleteOrHideContent"),
  };
}

function unsupported<Input, Output>(
  platform: SocialPlatform,
  operation: string
): (input: Input) => Promise<Output> {
  return async () => {
    throw new SocialPlatformUnsupportedError(platform, operation);
  };
}
