import type { MarketingAccount, MarketingPlatform, SocialAccount, SocialPlatform } from "@/lib/types";

export type CreativeApp = "higgsfield" | "hyperframes" | "open_generative_ai";

export type PlatformAuthReadinessInput = {
  socialAccounts?: SocialAccount[];
  marketingAccounts?: MarketingAccount[];
  requiredSocialPlatforms?: SocialPlatform[];
  requiredMarketingPlatforms?: MarketingPlatform[];
  requiredCreativeApps?: CreativeApp[];
  creativeCredentials?: Partial<Record<CreativeApp, boolean | string>>;
  marketingCredentials?: Partial<Record<MarketingPlatform, boolean | string>>;
  socialCredentials?: Partial<Record<SocialPlatform, boolean | string>>;
  socialPublishingRequested?: boolean;
  paidAdsRequested?: boolean;
  creativeGenerationRequested?: boolean;
};

export type PlatformAuthReadinessResult = {
  ready: boolean;
  approvalRequired: boolean;
  blockers: string[];
  instructions: string;
};

export type PlatformRequirementInference = Required<Pick<
  PlatformAuthReadinessInput,
  | "requiredSocialPlatforms"
  | "requiredMarketingPlatforms"
  | "requiredCreativeApps"
  | "socialPublishingRequested"
  | "paidAdsRequested"
  | "creativeGenerationRequested"
>>;

export function buildPlatformAuthReadiness(input: PlatformAuthReadinessInput): PlatformAuthReadinessResult {
  const blockers = [
    ...genericSocialBlockers(input),
    ...socialBlockers(input.requiredSocialPlatforms ?? [], input.socialAccounts ?? [], input.socialCredentials),
    ...genericMarketingBlockers(input),
    ...marketingBlockers(input.requiredMarketingPlatforms ?? [], input.marketingAccounts ?? [], input.marketingCredentials),
    ...creativeBlockers(input.requiredCreativeApps ?? [], input.creativeCredentials ?? {}),
    ...genericCreativeBlockers(input),
  ];

  return {
    ready: blockers.length === 0,
    approvalRequired: true,
    blockers,
    instructions: [
      blockers.length
        ? `Blocked until platform setup is complete: ${blockers.join("; ")}.`
        : "Connected platform checks are satisfied for draft execution.",
      "Publishing remains approval-gated.",
      "Paid spend remains approval-gated and must respect finance budget caps.",
      "If OAuth credentials are missing, create drafts and approval packets only.",
    ].join(" "),
  };
}

export function inferPlatformRequirements(text: string): PlatformRequirementInference {
  const requiredSocialPlatforms = inferPlatforms<SocialPlatform>(text, [
    ["tiktok", /\btik\s*tok\b|\btiktok\b/i],
    ["x", /\b(?:x|twitter|tweet|tweets)\b|x\.com/i],
    ["linkedin", /\blinkedin\b/i],
    ["instagram", /\binstagram\b|\big\b|\breels?\b/i],
    ["facebook", /\bfacebook\b|\bfb\b/i],
    ["youtube", /\byoutube\b|\bshorts?\b/i],
    ["threads", /\bthreads\b/i],
    ["bluesky", /\bbluesky\b/i],
    ["mastodon", /\bmastodon\b/i],
  ]);
  const requiredMarketingPlatforms = inferPlatforms<MarketingPlatform>(text, [
    ["meta", /\bmeta\b|\bfacebook ads?\b|\binstagram ads?\b/i],
    ["google", /\bgoogle ads?\b|\badwords\b/i],
    ["tiktok", /\btiktok ads?\b|\btik\s*tok ads?\b/i],
    ["linkedin", /\blinkedin ads?\b/i],
    ["reddit", /\breddit ads?\b/i],
  ]);
  const requiredCreativeApps = inferPlatforms<CreativeApp>(text, [
    ["higgsfield", /\bhiggsfield\b/i],
    ["hyperframes", /\bhyperframes?\b/i],
    ["open_generative_ai", /\bopen[- ]generative[- ]ai\b|\bopen gen(?:erative)? ai\b/i],
  ]);
  return {
    requiredSocialPlatforms,
    requiredMarketingPlatforms,
    requiredCreativeApps,
    socialPublishingRequested: /\b(publish|post|schedule|reply|dm|comment|reel|short|video|social)\b/i.test(text),
    paidAdsRequested: /\b(ad|ads|paid|boost|campaign|spend)\b/i.test(text),
    creativeGenerationRequested: /\b(video|creative|asset|generate|render|higgsfield|hyperframes|open[- ]generative[- ]ai)\b/i.test(text),
  };
}

function inferPlatforms<T extends string>(text: string, entries: Array<[T, RegExp]>): T[] {
  const found: T[] = [];
  for (const [platform, regex] of entries) {
    if (regex.test(text) && !found.includes(platform)) found.push(platform);
  }
  return found;
}

function genericSocialBlockers(input: PlatformAuthReadinessInput) {
  if (!input.socialPublishingRequested || (input.requiredSocialPlatforms?.length ?? 0) > 0) return [];
  return (input.socialAccounts ?? []).some((account) => account.status === "active")
    ? []
    : ["social publishing requested but no active social account is connected"];
}

function genericMarketingBlockers(input: PlatformAuthReadinessInput) {
  if (!input.paidAdsRequested || (input.requiredMarketingPlatforms?.length ?? 0) > 0) return [];
  return (input.marketingAccounts ?? []).some((account) => account.status === "active")
    ? []
    : ["paid ads requested but no active marketing account is connected"];
}

function socialBlockers(
  platforms: SocialPlatform[],
  accounts: SocialAccount[],
  credentials?: Partial<Record<SocialPlatform, boolean | string>>,
) {
  const byPlatform = new Map(accounts.map((account) => [account.platform, account]));
  const blockers: string[] = [];
  for (const platform of platforms) {
    const account = byPlatform.get(platform);
    if (!account || account.status !== "active") {
      blockers.push(`${platform} social account is not connected`);
      continue;
    }
    if (!account.credentialsRef) blockers.push(`${platform} credentials are missing`);
    if (credentials && !credentials[platform]) blockers.push(`${platform} social credentials are missing`);
    if (!account.scopes.includes("post:write")) blockers.push(`${platform} post:write scope is missing`);
    if (!account.autoPublishEnabled) blockers.push(`${platform} auto-publish is disabled`);
  }
  return blockers;
}

function marketingBlockers(
  platforms: MarketingPlatform[],
  accounts: MarketingAccount[],
  credentials?: Partial<Record<MarketingPlatform, boolean | string>>,
) {
  const byPlatform = new Map(accounts.map((account) => [account.platform, account]));
  const blockers: string[] = [];
  for (const platform of platforms) {
    const account = byPlatform.get(platform);
    if (!account || account.status !== "active") {
      blockers.push(`${platform} marketing account is not connected`);
      continue;
    }
    if (account.paymentStatus !== "ready") blockers.push(`${platform} payment status is ${account.paymentStatus}`);
    if (!account.dailyBudgetCents || account.dailyBudgetCents <= 0) blockers.push(`${platform} daily budget is not configured`);
    if (credentials && !credentials[platform]) blockers.push(`${platform} ads credentials are missing`);
  }
  return blockers;
}

function creativeBlockers(apps: CreativeApp[], credentials: Partial<Record<CreativeApp, boolean | string>>) {
  const blockers: string[] = [];
  for (const app of apps) {
    if (!credentials[app]) blockers.push(`${app} creative credentials are missing`);
  }
  return blockers;
}

function genericCreativeBlockers(input: PlatformAuthReadinessInput) {
  if (!input.creativeGenerationRequested || (input.requiredCreativeApps?.length ?? 0) > 0) return [];
  return Object.values(input.creativeCredentials ?? {}).some(Boolean)
    ? []
    : ["creative generation requested but no creative app credential is connected"];
}
