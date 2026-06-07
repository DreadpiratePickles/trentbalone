import type { MarketingAccount, MarketingAccountInput, MarketingPlatform } from "./types";

const MARKETING_PLATFORMS = new Set<string>(["meta", "google", "tiktok", "linkedin", "reddit"]);

export function normalizeMarketingPlatform(value: unknown): MarketingPlatform {
  if (typeof value !== "string") throw new Error("Unsupported marketing platform");
  const platform = value.trim().toLowerCase();
  if (!MARKETING_PLATFORMS.has(platform)) throw new Error(`Unsupported marketing platform: ${value}`);
  return platform as MarketingPlatform;
}

export function normalizeMarketingAccountInput(input: {
  companyId: unknown;
  platform: unknown;
  externalAccountId: unknown;
  externalBusinessId: unknown;
  currency: unknown;
  dailyBudgetCents: unknown;
  consentForServerEvents: unknown;
}): MarketingAccountInput {
  if (typeof input.companyId !== "string" || !input.companyId.trim()) {
    throw new Error("companyId is required");
  }
  if (typeof input.externalAccountId !== "string" || !input.externalAccountId.trim()) {
    throw new Error("externalAccountId is required");
  }
  if (typeof input.externalBusinessId !== "string" || !input.externalBusinessId.trim()) {
    throw new Error("externalBusinessId is required");
  }
  if (typeof input.currency !== "string" || !input.currency.trim()) {
    throw new Error("currency is required");
  }
  if (typeof input.consentForServerEvents !== "boolean") {
    throw new Error("consentForServerEvents must be boolean");
  }
  const dailyBudgetCents = input.dailyBudgetCents;
  if (typeof dailyBudgetCents !== "number" || !Number.isInteger(dailyBudgetCents) || dailyBudgetCents < 0) {
    throw new Error("dailyBudgetCents must be a non-negative integer");
  }

  return {
    companyId: input.companyId.trim(),
    platform: normalizeMarketingPlatform(input.platform),
    externalAccountId: input.externalAccountId.trim(),
    externalBusinessId: input.externalBusinessId.trim(),
    currency: input.currency.trim().toUpperCase(),
    dailyBudgetCents,
    consentForServerEvents: input.consentForServerEvents,
  };
}

export async function upsertMarketingAccountForCompany<
  TStore extends { upsertMarketingAccount(input: MarketingAccountInput): Promise<MarketingAccount> }
>(store: TStore, input: Parameters<typeof normalizeMarketingAccountInput>[0]) {
  return store.upsertMarketingAccount(normalizeMarketingAccountInput(input));
}
