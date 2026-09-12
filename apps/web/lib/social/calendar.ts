import type { Approval } from "@/lib/types";
import type { SocialAccount, SocialPlatform, SocialPost, SocialPostInput } from "./types";

export type { SocialAccount, SocialPlatform, SocialPost, SocialPostInput } from "./types";
export type ApprovalLike = Pick<Approval, "id" | "companyId" | "status"> & Partial<Approval>;

export type SocialCalendarStore = {
  createSocialPost(input: SocialPostInput): Promise<SocialPost>;
  createApproval(input: Parameters<SocialApprovalStore["createApproval"]>[0]): Promise<Approval>;
  updateSocialPost?(id: string, patch: Partial<SocialPost>): Promise<SocialPost | undefined>;
};

export type SocialApprovalStore = {
  createApproval(input: Omit<Approval, "id" | "status" | "createdAt">): Promise<Approval>;
};

export function adaptPostForPlatform(input: {
  platform: SocialPlatform;
  content: string;
  mediaUrls?: string[];
}): Pick<SocialPost, "platform" | "content" | "mediaUrls"> {
  const mediaUrls = input.mediaUrls ?? [];
  if (input.platform === "x") {
    return {
      platform: input.platform,
      content: truncate(input.content.trim(), 280),
      mediaUrls: mediaUrls.slice(0, 1),
    };
  }
  if (input.platform === "youtube") {
    return {
      platform: input.platform,
      content: truncate(input.content.trim(), 5_000),
      mediaUrls: mediaUrls.slice(0, 1),
    };
  }
  return {
    platform: input.platform,
    content: input.content.trim(),
    mediaUrls,
  };
}

export async function createSocialCalendarPosts(input: {
  store: SocialCalendarStore;
  companyId: string;
  accounts: SocialAccount[];
  content: string;
  mediaUrls?: string[];
  scheduledFor?: string;
  metadata?: Record<string, unknown>;
}) {
  const posts: SocialPost[] = [];
  const approvals: Approval[] = [];

  for (const account of input.accounts) {
    if (account.companyId !== input.companyId) {
      throw new Error("Social account does not belong to company");
    }
    if (account.status !== "active") {
      throw new Error("Social account must be active");
    }
    const adapted = adaptPostForPlatform({
      platform: account.platform,
      content: input.content,
      mediaUrls: input.mediaUrls,
    });
    const post = await input.store.createSocialPost({
      companyId: input.companyId,
      socialAccountId: account.id,
      platform: account.platform,
      status: input.scheduledFor ? "queued" : "draft",
      content: adapted.content,
      mediaUrls: adapted.mediaUrls,
      scheduledFor: input.scheduledFor,
      publishedAt: undefined,
      externalPostId: undefined,
      approvalId: undefined,
      metadata: input.metadata ?? {},
    });
    const approval = await createPublishingApproval({ store: input.store, post });
    const postWithApproval = input.store.updateSocialPost
      ? await input.store.updateSocialPost(post.id, { approvalId: approval.id })
      : { ...post, approvalId: approval.id };
    if (!postWithApproval) throw new Error("Failed to attach approval to social post");
    posts.push(postWithApproval);
    approvals.push(approval);
  }

  return { posts, approvals };
}

export async function createPublishingApproval(input: {
  store: SocialApprovalStore;
  post: SocialPost;
}) {
  return input.store.createApproval({
    companyId: input.post.companyId,
    action: "publish_social_post",
    reason: `Approve publishing ${input.post.platform} post ${input.post.id}`,
    toolName: "social_calendar",
    previewKind: "post",
    previewContent: formatPostApprovalPreview(input.post),
  });
}

export async function assertPublishingAllowed(input: {
  post: SocialPost;
  account: SocialAccount;
  approval?: ApprovalLike | null;
}) {
  if (!input.post.approvalId) {
    throw new Error("Publishing requires an approved approval record");
  }
  if (!input.approval || input.approval.id !== input.post.approvalId || input.approval.status !== "approved") {
    throw new Error("Publishing requires an approved approval record");
  }
  if (input.approval.companyId !== input.post.companyId) {
    throw new Error("Approval does not belong to this company");
  }
  if (input.account.companyId !== input.post.companyId || input.account.id !== input.post.socialAccountId) {
    throw new Error("Social account does not match post");
  }
  if (input.account.platform !== input.post.platform) {
    throw new Error("Social account platform does not match post");
  }
  if (input.account.status !== "active") {
    throw new Error("Social account must be active");
  }
  if (!input.account.autoPublishEnabled) {
    throw new Error("Auto-publish is disabled for this social account");
  }
  if (input.post.status === "published") {
    throw new Error("Social post is already published");
  }
}

function formatPostApprovalPreview(post: SocialPost) {
  const mediaCount = post.mediaUrls.length;
  const mediaSummary = mediaCount === 1 ? "1 media item" : `${mediaCount} media items`;
  return [
    `Platform: ${post.platform}`,
    `Content: ${post.content}`,
    `Media: ${mediaSummary}`,
    post.scheduledFor ? `Scheduled for: ${post.scheduledFor}` : "Scheduled for: unscheduled draft",
  ].join("\n");
}

function truncate(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength - 3).trimEnd() + "...";
}
