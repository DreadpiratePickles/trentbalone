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

export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];
export type SocialAccountStatus = "active" | "paused" | "disconnected";
export type SocialPostStatus = "draft" | "queued" | "scheduled" | "published" | "failed" | "cancelled";
export type SocialConversationStatus = "open" | "archived";
export type SocialContactEngagementState = "unknown" | "contacted" | "engaged" | "qualified" | "muted";
export type SocialContactOptOutStatus = "not_opted_out" | "opted_out";
export type SocialMessageDirection = "inbound" | "outbound";
export type SocialMessageKind = "dm" | "comment" | "reply" | "mention";

export type SocialAccount = {
  id: string;
  companyId: string;
  platform: SocialPlatform;
  status: SocialAccountStatus;
  externalAccountId: string;
  externalHandle?: string;
  displayName?: string;
  scopes: string[];
  credentialsRef?: string;
  autoPublishEnabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type SocialAccountInput = {
  companyId: string;
  platform: SocialPlatform;
  externalAccountId: string;
  externalHandle?: string;
  displayName?: string;
  scopes: string[];
  credentialsRef?: string;
  autoPublishEnabled?: boolean;
  status?: SocialAccountStatus;
};

export type SocialPost = {
  id: string;
  companyId: string;
  socialAccountId: string;
  platform: SocialPlatform;
  status: SocialPostStatus;
  content: string;
  mediaUrls: string[];
  scheduledFor?: string;
  publishedAt?: string;
  externalPostId?: string;
  approvalId?: string;
  adaptedFromPostId?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type SocialPostInput = Omit<SocialPost, "id" | "createdAt" | "updatedAt">;
export type SocialPostPatch = Partial<Omit<SocialPost, "id" | "companyId" | "socialAccountId" | "platform" | "createdAt">>;

export type SocialContact = {
  id: string;
  companyId: string;
  platform: SocialPlatform;
  externalContactId: string;
  handle?: string;
  displayName?: string;
  profileUrl?: string;
  engagementState: SocialContactEngagementState;
  optOutStatus: SocialContactOptOutStatus;
  lastOutboundAt?: string;
  lastInboundAt?: string;
  memory: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type SocialContactInput = Omit<
  SocialContact,
  "id" | "createdAt" | "updatedAt" | "engagementState" | "optOutStatus" | "memory"
> & {
  engagementState?: SocialContactEngagementState;
  optOutStatus?: SocialContactOptOutStatus;
  memory?: Record<string, unknown>;
};
export type SocialContactPatch = Partial<Omit<SocialContact, "id" | "companyId" | "platform" | "externalContactId" | "createdAt">>;

export type SocialConversation = {
  id: string;
  companyId: string;
  socialAccountId: string;
  platform: SocialPlatform;
  externalThreadId: string;
  contactId?: string;
  status: SocialConversationStatus;
  lastMessageAt?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type SocialConversationInput = Omit<SocialConversation, "id" | "createdAt" | "updatedAt" | "status"> & {
  status?: SocialConversationStatus;
};
export type SocialConversationPatch = Partial<Omit<SocialConversation, "id" | "companyId" | "socialAccountId" | "platform" | "externalThreadId" | "createdAt">>;

export type SocialMessage = {
  id: string;
  companyId: string;
  conversationId: string;
  contactId?: string;
  direction: SocialMessageDirection;
  kind: SocialMessageKind;
  content: string;
  externalMessageId?: string;
  sentAt?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type SocialMessageInput = Omit<SocialMessage, "id" | "createdAt" | "updatedAt">;

export type SocialPlatformGuidance = Partial<Record<SocialPlatform, string>>;

export type SocialVoicePolicy = {
  id: string;
  companyId: string;
  tone: string;
  hashtagPolicy: string;
  emojiPolicy: string;
  restrictedTerms: string[];
  platformGuidance: SocialPlatformGuidance;
  createdAt: string;
  updatedAt: string;
};

export type SocialVoicePolicyInput = Omit<SocialVoicePolicy, "id" | "createdAt" | "updatedAt">;

export type SocialAnalyticsSnapshot = {
  id: string;
  companyId: string;
  socialAccountId: string;
  platform: SocialPlatform;
  periodStart: string;
  periodEnd: string;
  metrics: Record<string, unknown>;
  report: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type SocialAnalyticsSnapshotInput = Omit<SocialAnalyticsSnapshot, "id" | "createdAt" | "updatedAt">;

export type SocialOutreachDraftStatus = "draft" | "pending_approval" | "approved" | "rejected" | "sent" | "cancelled";

export type SocialOutreachDraft = {
  id: string;
  companyId: string;
  contactId: string;
  platform: SocialPlatform;
  purpose: string;
  message: string;
  status: SocialOutreachDraftStatus;
  approvalId?: string;
  riskFlags: string[];
  createdAt: string;
  updatedAt: string;
};

export type SocialOutreachDraftInput = Omit<SocialOutreachDraft, "id" | "createdAt" | "updatedAt">;
export type SocialOutreachDraftPatch = Partial<Omit<SocialOutreachDraft, "id" | "companyId" | "contactId" | "platform" | "createdAt">>;
