import { encryptJson, maskSecret } from "@/lib/secrets";
import { normalizeMarketingPlatform } from "@/lib/marketing/accounts";
import { normalizeSocialPlatform } from "@/lib/social/accounts";
import { SOCIAL_PLATFORMS, type SocialPlatform } from "@/lib/social/types";
import type { MarketingAccount, MarketingPlatform, SocialAccount, ToolConnection } from "@/lib/types";
import { store } from "@/lib/store";

const MARKETING_PLATFORMS: MarketingPlatform[] = ["meta", "google", "tiktok", "linkedin", "reddit"];

export type SocialPlatformConnectionInput = {
  platform: SocialPlatform;
  accessToken: string;
  refreshToken?: string;
  tokenExpiresAt?: string;
  refreshTokenExpiresAt?: string;
  externalAccountId: string;
  externalHandle?: string;
  displayName?: string;
  scopes?: string[];
  autoPublishEnabled?: boolean;
};

export type MarketingPlatformConnectionInput = {
  platform: MarketingPlatform;
  accessToken: string;
  refreshToken?: string;
  tokenExpiresAt?: string;
  refreshTokenExpiresAt?: string;
  externalAccountId: string;
  externalBusinessId?: string;
  currency?: string;
  dailyBudgetCents?: number;
  paymentStatus?: MarketingAccount["paymentStatus"];
  consentForServerEvents?: boolean;
};

export type PlatformConnectionStatus = {
  platform: SocialPlatform | MarketingPlatform;
  provider: string;
  status: ToolConnection["status"];
  source: "company" | "missing";
  scopes: string[];
  accessToken?: string;
  lastCheckedAt?: string;
};

export async function saveSocialPlatformConnection(companyId: string, input: SocialPlatformConnectionInput) {
  const platform = normalizeSocialPlatform(input.platform);
  const accessToken = normalizeSecret(input.accessToken, "accessToken");
  const scopes = input.scopes?.length ? input.scopes : ["post:write"];
  const connection = await store.upsertIntegration({
    companyId,
    provider: socialProvider(platform),
    scopes,
    status: "connected",
    encryptedData: encryptJson({
      kind: "social",
      platform,
      accessToken,
      refreshToken: optionalText(input.refreshToken),
      tokenExpiresAt: optionalText(input.tokenExpiresAt),
      refreshTokenExpiresAt: optionalText(input.refreshTokenExpiresAt),
      externalAccountId: input.externalAccountId,
      scopes,
    }),
  });
  const account = await store.upsertSocialAccount({
    companyId,
    platform,
    externalAccountId: normalizeText(input.externalAccountId, "externalAccountId"),
    externalHandle: optionalText(input.externalHandle),
    displayName: optionalText(input.displayName),
    scopes,
    credentialsRef: connection.id,
    autoPublishEnabled: input.autoPublishEnabled ?? false,
    status: "active",
  });
  return { connection, account };
}

export async function saveMarketingPlatformConnection(companyId: string, input: MarketingPlatformConnectionInput) {
  const platform = normalizeMarketingPlatform(input.platform);
  const accessToken = normalizeSecret(input.accessToken, "accessToken");
  const connection = await store.upsertIntegration({
    companyId,
    provider: marketingProvider(platform),
    scopes: ["ads:manage"],
    status: "connected",
    encryptedData: encryptJson({
      kind: "ads",
      platform,
      accessToken,
      refreshToken: optionalText(input.refreshToken),
      tokenExpiresAt: optionalText(input.tokenExpiresAt),
      refreshTokenExpiresAt: optionalText(input.refreshTokenExpiresAt),
      externalAccountId: input.externalAccountId,
    }),
  });
  const account = await store.upsertMarketingAccount({
    companyId,
    platform,
    externalAccountId: normalizeText(input.externalAccountId, "externalAccountId"),
    externalBusinessId: optionalText(input.externalBusinessId),
    currency: input.currency,
    dailyBudgetCents: input.dailyBudgetCents,
    consentForServerEvents: input.consentForServerEvents,
    paymentStatus: input.paymentStatus,
    status: "active",
  });
  return { connection, account };
}

export async function getMarketingCredentialMap(companyId: string): Promise<Partial<Record<MarketingPlatform, boolean>>> {
  const pairs = await Promise.all(MARKETING_PLATFORMS.map(async (platform) => [
    platform,
    isUsableConnection(await store.getIntegration(companyId, marketingProvider(platform)), "ads:manage"),
  ] as const));
  return Object.fromEntries(pairs) as Partial<Record<MarketingPlatform, boolean>>;
}

export async function getSocialCredentialMap(companyId: string): Promise<Partial<Record<SocialPlatform, boolean>>> {
  const pairs = await Promise.all(SOCIAL_PLATFORMS.map(async (platform) => [
    platform,
    isUsableConnection(await store.getIntegration(companyId, socialProvider(platform)), "post:write"),
  ] as const));
  return Object.fromEntries(pairs) as Partial<Record<SocialPlatform, boolean>>;
}

export async function listPlatformConnectionStatuses(companyId: string) {
  const [social, marketing] = await Promise.all([
    Promise.all(SOCIAL_PLATFORMS.map((platform) => statusFor(companyId, platform, socialProvider(platform)))),
    Promise.all(MARKETING_PLATFORMS.map((platform) => statusFor(companyId, platform, marketingProvider(platform)))),
  ]);
  return { social, marketing };
}

async function statusFor(
  companyId: string,
  platform: SocialPlatform | MarketingPlatform,
  provider: string,
): Promise<PlatformConnectionStatus> {
  const connection = await store.getIntegration(companyId, provider);
  if (!connection) return { platform, provider, status: "needs_credentials", source: "missing", scopes: [] };
  return {
    platform,
    provider,
    status: connection.status,
    source: "company",
    scopes: connection.scopes,
    accessToken: connection.encryptedData ? maskSecret("connected-token") : undefined,
    lastCheckedAt: connection.lastCheckedAt,
  };
}

function socialProvider(platform: SocialPlatform) {
  return `Social:${title(platform)}`;
}

function marketingProvider(platform: MarketingPlatform) {
  return `Ads:${title(platform)}`;
}

function title(value: string) {
  if (value === "tiktok") return "TikTok";
  return value === "x" ? "X" : value[0]?.toUpperCase() + value.slice(1);
}

function normalizeSecret(value: string, field: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function normalizeText(value: string | undefined, field: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function optionalText(value: string | undefined) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isUsableConnection(
  connection: Awaited<ReturnType<typeof store.getIntegration>>,
  requiredScope: string,
) {
  return Boolean(
    connection
    && connection.status === "connected"
    && connection.scopes.includes(requiredScope)
    && connection.encryptedData,
  );
}
