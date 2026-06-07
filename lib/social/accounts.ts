import type { SocialAccount, SocialAccountInput, SocialPlatform } from "./types";
import { SOCIAL_PLATFORMS } from "./types";

export { SOCIAL_PLATFORMS };

const SOCIAL_PLATFORM_SET = new Set<string>(SOCIAL_PLATFORMS);

export function normalizeSocialPlatform(value: unknown): SocialPlatform {
  if (typeof value !== "string") throw new Error("Unsupported social platform");
  const platform = value.trim().toLowerCase();
  if (!SOCIAL_PLATFORM_SET.has(platform)) throw new Error(`Unsupported social platform: ${value}`);
  return platform as SocialPlatform;
}

export function normalizeSocialAccountInput(input: {
  companyId: unknown;
  platform: unknown;
  externalAccountId: unknown;
  externalHandle?: unknown;
  displayName?: unknown;
  scopes?: unknown;
  credentialsRef?: unknown;
  autoPublishEnabled?: unknown;
}): SocialAccountInput {
  if (typeof input.companyId !== "string" || !input.companyId.trim()) throw new Error("companyId is required");
  if (typeof input.externalAccountId !== "string" || !input.externalAccountId.trim()) {
    throw new Error("externalAccountId is required");
  }
  const scopes = input.scopes;
  if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== "string" || !scope.trim())) {
    throw new Error("scopes must be a string array");
  }
  if (input.autoPublishEnabled !== undefined && typeof input.autoPublishEnabled !== "boolean") {
    throw new Error("autoPublishEnabled must be boolean");
  }

  return {
    companyId: input.companyId.trim(),
    platform: normalizeSocialPlatform(input.platform),
    externalAccountId: input.externalAccountId.trim(),
    externalHandle:
      typeof input.externalHandle === "string" && input.externalHandle.trim() ? input.externalHandle.trim() : undefined,
    displayName: typeof input.displayName === "string" && input.displayName.trim() ? input.displayName.trim() : undefined,
    scopes: scopes.map((scope) => scope.trim()),
    credentialsRef:
      typeof input.credentialsRef === "string" && input.credentialsRef.trim() ? input.credentialsRef.trim() : undefined,
    autoPublishEnabled: input.autoPublishEnabled ?? false,
  };
}

export async function upsertSocialAccountForCompany<
  TStore extends { upsertSocialAccount(input: SocialAccountInput): Promise<SocialAccount> },
>(store: TStore, input: Parameters<typeof normalizeSocialAccountInput>[0]) {
  return store.upsertSocialAccount(normalizeSocialAccountInput(input));
}
