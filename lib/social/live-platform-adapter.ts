import { scrubSecrets } from "@/lib/credential-boundary";
import { decryptJson } from "@/lib/secrets";
import { store } from "@/lib/store";
import type {
  SocialAnalytics,
  SocialInboxMessage,
  SocialPlatform,
  SocialPlatformAdapter,
  SocialPlatformCapabilities,
  SocialPlatformErrorCode,
  SocialPublishedPost,
} from "./platform-adapter";

export type SocialCredential = {
  accessToken: string;
  refreshToken?: string;
  tokenExpiresAt?: string;
  externalAccountId: string;
  scopes?: string[];
};

export class SocialPlatformApiError extends Error {
  constructor(
    public readonly platform: SocialPlatform,
    public readonly operation: string,
    public readonly code: SocialPlatformErrorCode,
    message: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(`${platform} ${operation} failed: ${message}`);
    this.name = "SocialPlatformApiError";
  }
}

type JsonFetch = (url: string, init?: RequestInit) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
  headers?: { get(name: string): string | null };
}>;

type LiveSocialAdapterDeps = {
  httpFetch?: JsonFetch;
  tokenResolver?: (input: {
    companyId: string;
    platform: SocialPlatform;
    externalAccountId: string;
  }) => Promise<SocialCredential | undefined>;
  graphVersion?: string;
  now?: () => string;
};

const LIVE_SOCIAL_PLATFORMS = new Set<SocialPlatform>(["x", "instagram", "facebook", "linkedin", "tiktok", "youtube"]);
const BASE_CAPABILITIES: SocialPlatformCapabilities = {
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
const LIVE_CAPABILITIES: Partial<Record<SocialPlatform, SocialPlatformCapabilities>> = {
  x: capabilities({ posts: true, replies: true, inbox: true, analytics: true, moderationActions: true }),
  facebook: capabilities({ posts: true, replies: true, dms: true, inbox: true, analytics: true, videoUpload: true, moderationActions: true }),
  instagram: capabilities({ posts: true, replies: true, inbox: true, analytics: true, videoUpload: true, storiesReels: true, moderationActions: true }),
  linkedin: capabilities({ posts: true, replies: true, inbox: true, analytics: true, videoUpload: true, moderationActions: true }),
  tiktok: capabilities({ posts: true, analytics: true, videoUpload: true }),
  youtube: capabilities({ replies: true, inbox: true, analytics: true, videoUpload: true, moderationActions: true }),
};

export function isLiveSocialPlatform(platform: SocialPlatform) {
  return LIVE_SOCIAL_PLATFORMS.has(platform);
}

export function createLiveSocialAdapter(platform: SocialPlatform, deps: LiveSocialAdapterDeps = {}): SocialPlatformAdapter {
  const httpFetch = deps.httpFetch ?? (fetch as unknown as JsonFetch);
  const graphVersion = deps.graphVersion ?? "v20.0";
  const now = deps.now ?? (() => new Date().toISOString());

  async function credential(input: { companyId: string; externalAccountId: string }) {
    const resolved = deps.tokenResolver
      ? await deps.tokenResolver({ companyId: input.companyId, platform, externalAccountId: input.externalAccountId })
      : await resolveSocialCredential(input.companyId, platform);
    if (!resolved?.accessToken) throw apiError(platform, "credential", "needs_credentials", "No connected social access token is available.");
    if (resolved.tokenExpiresAt && new Date(resolved.tokenExpiresAt).getTime() <= Date.now()) {
      throw apiError(platform, "credential", "expired_token", "The connected social access token is expired; refresh OAuth before retrying.");
    }
    return { ...resolved, externalAccountId: input.externalAccountId || resolved.externalAccountId };
  }

  async function request<T>(operation: string, cred: SocialCredential, url: string, init: RequestInit): Promise<T> {
    try {
      const res = await httpFetch(url, { ...init, headers: { Authorization: `Bearer ${cred.accessToken}`, ...(init.headers ?? {}) } });
      if (!res.ok) {
        const body = await res.text();
        throw classifyProviderError(platform, operation, res.status, body, cred.accessToken, res.headers?.get("retry-after"));
      }
      return await res.json() as T;
    } catch (error) {
      if (error instanceof SocialPlatformApiError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw apiError(platform, operation, "provider_error", scrubSecrets(message, { token: cred.accessToken }));
    }
  }

  return {
    platform,
    capabilities: LIVE_CAPABILITIES[platform] ?? { ...BASE_CAPABILITIES },

    async createPostDraft(input) {
      return { platform, externalDraftId: deterministicRef("draft", input.companyId, input.socialAccountId, input.content), status: "draft" };
    },

    async publishPost(input) {
      const cred = await credential(input);
      if (platform === "x") {
        const data = await request<{ data?: { id?: string } }>("publishPost", cred, "https://api.x.com/2/tweets", jsonPost({ text: input.content }));
        return published(platform, requireId(data.data?.id, platform, "publishPost"), now());
      }
      if (platform === "facebook") {
        const body = new URLSearchParams({ message: input.content });
        if (input.mediaUrls?.[0]) body.set("link", input.mediaUrls[0]);
        const data = await request<{ id?: string }>("publishPost", cred, `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(cred.externalAccountId)}/feed`, formPost(body));
        return published(platform, requireId(data.id, platform, "publishPost"), now());
      }
      if (platform === "instagram") {
        const mediaUrl = input.mediaUrls?.[0];
        if (!mediaUrl) throw apiError(platform, "publishPost", "rejected_content", "Instagram publishing requires at least one image or video URL.");
        const createBody = new URLSearchParams({ caption: input.content });
        if (isVideoUrl(mediaUrl)) {
          createBody.set("media_type", "REELS");
          createBody.set("video_url", mediaUrl);
        } else createBody.set("image_url", mediaUrl);
        const container = await request<{ id?: string }>("publishPost.createContainer", cred, `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(cred.externalAccountId)}/media`, formPost(createBody));
        const creationId = requireId(container.id, platform, "publishPost.createContainer");
        const data = await request<{ id?: string }>("publishPost.publishContainer", cred, `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(cred.externalAccountId)}/media_publish`, formPost(new URLSearchParams({ creation_id: creationId })));
        return published(platform, requireId(data.id, platform, "publishPost.publishContainer"), now());
      }
      if (platform === "linkedin") {
        const author = cred.externalAccountId.startsWith("urn:li:") ? cred.externalAccountId : `urn:li:person:${cred.externalAccountId}`;
        const data = await request<{ id?: string }>("publishPost", cred, "https://api.linkedin.com/v2/ugcPosts", jsonPost(linkedinPostBody(author, input.content, input.mediaUrls?.[0])));
        return published(platform, requireId(data.id, platform, "publishPost"), now());
      }
      if (platform === "tiktok") {
        const mediaUrl = input.mediaUrls?.find(isVideoUrl);
        if (!mediaUrl) throw apiError(platform, "publishPost", "rejected_content", "TikTok Direct Post requires a video URL.");
        const data = await request<{ data?: { publish_id?: string } }>("publishPost", cred, `${tiktokBaseUrl()}/v2/post/publish/video/init/`, jsonPost({
          post_info: { title: input.content.slice(0, 2200), privacy_level: "SELF_ONLY", disable_duet: false, disable_comment: false, disable_stitch: false },
          source_info: { source: "PULL_FROM_URL", video_url: mediaUrl },
        }));
        return published(platform, requireId(data.data?.publish_id, platform, "publishPost"), now());
      }
      throw unsupportedApi(platform, "publishPost");
    },

    async reply(input) {
      const cred = await credential(input);
      if (platform === "x") {
        const data = await request<{ data?: { id?: string } }>("reply", cred, "https://api.x.com/2/tweets", jsonPost({ text: input.content, reply: { in_reply_to_tweet_id: input.externalThreadId } }));
        return { platform, externalReplyId: requireId(data.data?.id, platform, "reply"), status: "sent" };
      }
      if (platform === "facebook" || platform === "instagram") {
        const data = await request<{ id?: string }>("reply", cred, `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(input.externalThreadId)}/comments`, formPost(new URLSearchParams({ message: input.content })));
        return { platform, externalReplyId: requireId(data.id, platform, "reply"), status: "sent" };
      }
      if (platform === "youtube") {
        const data = await request<{ id?: string }>("reply", cred, "https://www.googleapis.com/youtube/v3/comments?part=snippet", jsonPost({ snippet: { parentId: input.externalThreadId, textOriginal: input.content } }));
        return { platform, externalReplyId: requireId(data.id, platform, "reply"), status: "sent" };
      }
      throw unsupportedApi(platform, "reply");
    },

    async sendDm(input) {
      throw unsupportedApi(platform, `sendDm:${input.externalContactId}`);
    },

    async fetchInbox(input) {
      const cred = await credential(input);
      if (platform === "x") {
        const params = new URLSearchParams({ "tweet.fields": "author_id,conversation_id,created_at", max_results: String(Math.min(Math.max(input.limit ?? 10, 5), 100)) });
        if (input.since) params.set("start_time", input.since);
        const data = await request<{ data?: XPost[] }>("fetchInbox", cred, `https://api.x.com/2/users/${encodeURIComponent(cred.externalAccountId)}/mentions?${params.toString()}`, { method: "GET" });
        return { platform, messages: (data.data ?? []).map(xInboxMessage), status: "fetched" };
      }
      if (platform === "facebook") {
        const data = await request<{ conversations?: { data?: FacebookConversation[] } }>("fetchInbox", cred, `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(cred.externalAccountId)}?fields=conversations.limit(${input.limit ?? 25}){messages.limit(5){message,from,created_time,id}}`, { method: "GET" });
        return { platform, messages: facebookInboxMessages(data.conversations?.data ?? []), status: "fetched" };
      }
      if (platform === "instagram") {
        const data = await request<{ data?: InstagramMedia[] }>("fetchInbox", cred, `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(cred.externalAccountId)}/media?fields=id,comments.limit(${input.limit ?? 25}){id,text,username,timestamp}`, { method: "GET" });
        return { platform, messages: instagramInboxMessages(data.data ?? []), status: "fetched" };
      }
      if (platform === "youtube") {
        const params = new URLSearchParams({ part: "snippet", allThreadsRelatedToChannelId: cred.externalAccountId, maxResults: String(Math.min(input.limit ?? 25, 100)), order: "time" });
        const data = await request<{ items?: YouTubeCommentThread[] }>("fetchInbox", cred, `https://www.googleapis.com/youtube/v3/commentThreads?${params.toString()}`, { method: "GET" });
        return { platform, messages: youtubeInboxMessages(data.items ?? []), status: "fetched" };
      }
      throw unsupportedApi(platform, "fetchInbox");
    },

    async fetchAnalytics(input) {
      const cred = await credential(input);
      if (platform === "x") {
        if (!input.externalPostId) throw apiError(platform, "fetchAnalytics", "rejected_content", "externalPostId is required for X analytics.");
        const data = await request<{ data?: { public_metrics?: XPublicMetrics } }>("fetchAnalytics", cred, `https://api.x.com/2/tweets/${encodeURIComponent(input.externalPostId)}?tweet.fields=public_metrics`, { method: "GET" });
        return xAnalytics(data.data?.public_metrics);
      }
      if (platform === "facebook" || platform === "instagram") {
        if (!input.externalPostId) throw apiError(platform, "fetchAnalytics", "rejected_content", "externalPostId is required for Meta social analytics.");
        const data = await request<{ data?: Array<{ name: string; values?: Array<{ value: number }> }> }>("fetchAnalytics", cred, `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(input.externalPostId)}/insights?metric=impressions,reach,engagement,saved,video_views`, { method: "GET" });
        return metaAnalytics(platform, data.data ?? []);
      }
      if (platform === "youtube") {
        if (!input.externalPostId) throw apiError(platform, "fetchAnalytics", "rejected_content", "externalPostId is required for YouTube analytics.");
        const data = await request<{ items?: Array<{ statistics?: Record<string, string> }> }>("fetchAnalytics", cred, `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${encodeURIComponent(input.externalPostId)}`, { method: "GET" });
        return youtubeAnalytics(data.items?.[0]?.statistics);
      }
      throw unsupportedApi(platform, "fetchAnalytics");
    },

    async deleteOrHideContent(input) {
      const cred = await credential(input);
      if (platform === "x" && input.action === "delete") {
        await request<Record<string, unknown>>("deleteOrHideContent", cred, `https://api.x.com/2/tweets/${encodeURIComponent(input.externalContentId)}`, { method: "DELETE" });
        return { platform, externalContentId: input.externalContentId, action: input.action, status: "completed" };
      }
      if (platform === "facebook" || platform === "instagram") {
        await request<Record<string, unknown>>("deleteOrHideContent", cred, `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(input.externalContentId)}`, { method: "DELETE" });
        return { platform, externalContentId: input.externalContentId, action: input.action, status: "completed" };
      }
      throw unsupportedApi(platform, "deleteOrHideContent");
    },
  };
}

async function resolveSocialCredential(companyId: string, platform: SocialPlatform): Promise<SocialCredential | undefined> {
  const integration = await store.getIntegration(companyId, socialProvider(platform));
  if (!integration?.encryptedData || integration.status !== "connected") return undefined;
  const data = decryptJson<Partial<SocialCredential>>(integration.encryptedData);
  if (!data.accessToken || !data.externalAccountId) return undefined;
  return { accessToken: data.accessToken, refreshToken: data.refreshToken, tokenExpiresAt: data.tokenExpiresAt, externalAccountId: data.externalAccountId, scopes: data.scopes };
}

function socialProvider(platform: SocialPlatform) {
  if (platform === "tiktok") return "Social:TikTok";
  if (platform === "x") return "Social:X";
  return `Social:${platform[0]?.toUpperCase()}${platform.slice(1)}`;
}

function capabilities(overrides: Partial<SocialPlatformCapabilities>): SocialPlatformCapabilities {
  return { ...BASE_CAPABILITIES, ...overrides };
}

function jsonPost(body: unknown): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function formPost(body: URLSearchParams): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body };
}

function published(platform: SocialPlatform, externalPostId: string, publishedAt: string): SocialPublishedPost {
  return { platform, externalPostId, status: "published", publishedAt };
}

function requireId(value: string | undefined, platform: SocialPlatform, operation: string) {
  if (typeof value === "string" && value.trim()) return value.trim();
  throw apiError(platform, operation, "partial_publication", "Provider response did not include an external id.");
}

function apiError(platform: SocialPlatform, operation: string, code: SocialPlatformErrorCode, message: string, retryAfterSeconds?: number) {
  return new SocialPlatformApiError(platform, operation, code, message, retryAfterSeconds);
}

function unsupportedApi(platform: SocialPlatform, operation: string): never {
  throw apiError(platform, operation, "unsupported_operation", `Live ${platform} ${operation} is not supported by this adapter.`);
}

function classifyProviderError(platform: SocialPlatform, operation: string, status: number, body: string, token: string, retryAfter: string | null | undefined) {
  const scrubbed = scrubSecrets(body, { token });
  if (status === 401 || /expired|invalid token|oauth/i.test(scrubbed)) return apiError(platform, operation, "expired_token", scrubbed);
  if (status === 429) {
    const retry = retryAfter ? Number.parseInt(retryAfter, 10) : undefined;
    return apiError(platform, operation, "rate_limited", scrubbed, Number.isFinite(retry) ? retry : undefined);
  }
  if (status === 400 || status === 422) return apiError(platform, operation, "rejected_content", scrubbed);
  return apiError(platform, operation, "provider_error", `HTTP ${status}: ${scrubbed}`);
}

function linkedinPostBody(author: string, content: string, mediaUrl?: string) {
  return {
    author,
    lifecycleState: "PUBLISHED",
    specificContent: {
      "com.linkedin.ugc.ShareContent": {
        shareCommentary: { text: content },
        shareMediaCategory: mediaUrl ? "ARTICLE" : "NONE",
        media: mediaUrl ? [{ status: "READY", originalUrl: mediaUrl, title: { text: content.slice(0, 80) } }] : undefined,
      },
    },
    visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
  };
}

function isVideoUrl(value: string) {
  return /\.(mp4|mov|m4v|webm)(\?|#|$)/i.test(value);
}

function tiktokBaseUrl() {
  return (process.env.TIKTOK_API_BASE_URL ?? "https://open.tiktokapis.com").replace(/\/+$/, "");
}

type XPost = { id?: string; text?: string; author_id?: string; conversation_id?: string; created_at?: string };

function xInboxMessage(post: XPost): SocialInboxMessage {
  const id = post.id ?? "unknown";
  return { externalMessageId: id, externalThreadId: post.conversation_id ?? id, externalContactId: post.author_id ?? "unknown", direction: "inbound", kind: "mention", content: post.text ?? "", sentAt: post.created_at ?? new Date(0).toISOString(), metadata: { source: "x_mentions" } };
}

type FacebookConversation = {
  id?: string;
  messages?: { data?: Array<{ id?: string; message?: string; created_time?: string; from?: { id?: string; name?: string } }> };
};

function facebookInboxMessages(conversations: FacebookConversation[]): SocialInboxMessage[] {
  return conversations.flatMap((conversation) => (conversation.messages?.data ?? []).map((message) => ({
    externalMessageId: message.id ?? `${conversation.id}:message`,
    externalThreadId: conversation.id ?? message.id ?? "unknown",
    externalContactId: message.from?.id ?? "unknown",
    direction: "inbound" as const,
    kind: "dm" as const,
    content: message.message ?? "",
    sentAt: message.created_time ?? new Date(0).toISOString(),
    metadata: { fromName: message.from?.name },
  })));
}

type InstagramMedia = { id?: string; comments?: { data?: Array<{ id?: string; text?: string; username?: string; timestamp?: string }> } };

function instagramInboxMessages(media: InstagramMedia[]): SocialInboxMessage[] {
  return media.flatMap((item) => (item.comments?.data ?? []).map((comment) => ({
    externalMessageId: comment.id ?? `${item.id}:comment`,
    externalThreadId: item.id ?? comment.id ?? "unknown",
    externalContactId: comment.username ?? "unknown",
    direction: "inbound" as const,
    kind: "comment" as const,
    content: comment.text ?? "",
    sentAt: comment.timestamp ?? new Date(0).toISOString(),
    metadata: { username: comment.username },
  })));
}

type YouTubeCommentThread = {
  id?: string;
  snippet?: { topLevelComment?: { id?: string; snippet?: { textOriginal?: string; authorChannelId?: { value?: string }; publishedAt?: string } } };
};

function youtubeInboxMessages(items: YouTubeCommentThread[]): SocialInboxMessage[] {
  return items.map((item) => {
    const comment = item.snippet?.topLevelComment;
    return {
      externalMessageId: comment?.id ?? item.id ?? "unknown",
      externalThreadId: item.id ?? comment?.id ?? "unknown",
      externalContactId: comment?.snippet?.authorChannelId?.value ?? "unknown",
      direction: "inbound" as const,
      kind: "comment" as const,
      content: comment?.snippet?.textOriginal ?? "",
      sentAt: comment?.snippet?.publishedAt ?? new Date(0).toISOString(),
      metadata: { source: "youtube_comment_threads" },
    };
  });
}

type XPublicMetrics = { impression_count?: number; like_count?: number; reply_count?: number; retweet_count?: number; quote_count?: number };

function xAnalytics(metrics: XPublicMetrics | undefined): SocialAnalytics {
  const engagements = (metrics?.like_count ?? 0) + (metrics?.reply_count ?? 0) + (metrics?.retweet_count ?? 0) + (metrics?.quote_count ?? 0);
  return { platform: "x", impressions: metrics?.impression_count ?? 0, engagements, clicks: 0, followersDelta: 0, videoViews: 0 };
}

function metaAnalytics(platform: SocialPlatform, rows: Array<{ name: string; values?: Array<{ value: number }> }>): SocialAnalytics {
  const values = Object.fromEntries(rows.map((row) => [row.name, Number(row.values?.[0]?.value ?? 0)]));
  return { platform, impressions: values.impressions ?? values.reach ?? 0, engagements: values.engagement ?? values.saved ?? 0, clicks: 0, followersDelta: 0, videoViews: values.video_views ?? 0 };
}

function youtubeAnalytics(stats: Record<string, string> | undefined): SocialAnalytics {
  return { platform: "youtube", impressions: Number(stats?.viewCount ?? 0), engagements: Number(stats?.likeCount ?? 0) + Number(stats?.commentCount ?? 0), clicks: 0, followersDelta: 0, videoViews: Number(stats?.viewCount ?? 0) };
}

function deterministicRef(prefix: string, ...parts: string[]) {
  let hash = 0;
  for (const char of parts.join(":")) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return `${prefix}_${Math.abs(hash).toString(36)}`;
}
