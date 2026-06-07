import { getBrandVoiceContext, type BrandVoiceProfile } from "@/lib/brand/voice-memory";
import { normalizeSocialPlatform } from "./accounts";
import { SOCIAL_PLATFORMS, type SocialPlatform, type SocialVoicePolicy, type SocialVoicePolicyInput } from "./types";

export type { SocialVoicePolicy, SocialVoicePolicyInput } from "./types";

export type AppliedSocialVoicePolicy = {
  content: string;
  guidance: string;
};

export class RestrictedSocialVoiceTermError extends Error {
  constructor(term: string) {
    super(`Restricted social voice term found: ${term}`);
    this.name = "RestrictedSocialVoiceTermError";
  }
}

type VoicePolicyStore = {
  upsertSocialVoicePolicy(input: SocialVoicePolicyInput): Promise<SocialVoicePolicy>;
};

type VoicePolicyReadStore = {
  getSocialVoicePolicy(companyId: string): Promise<SocialVoicePolicy | null | undefined>;
};

export function normalizeSocialVoicePolicyInput(input: {
  companyId?: unknown;
  tone?: unknown;
  hashtagPolicy?: unknown;
  emojiPolicy?: unknown;
  restrictedTerms?: unknown;
  platformGuidance?: unknown;
}): SocialVoicePolicyInput {
  const companyId = requiredString(input.companyId, "companyId");
  const tone = requiredString(input.tone, "tone");
  const hashtagPolicy = requiredString(input.hashtagPolicy, "hashtagPolicy");
  const emojiPolicy = requiredString(input.emojiPolicy, "emojiPolicy");
  const restrictedTerms = normalizeRestrictedTerms(input.restrictedTerms);
  const platformGuidance = normalizePlatformGuidance(input.platformGuidance);

  return { companyId, tone, hashtagPolicy, emojiPolicy, restrictedTerms, platformGuidance };
}

export async function upsertSocialVoicePolicy<TStore extends VoicePolicyStore>(
  store: TStore,
  input: Parameters<typeof normalizeSocialVoicePolicyInput>[0],
) {
  return store.upsertSocialVoicePolicy(normalizeSocialVoicePolicyInput(input));
}

export async function getSocialVoicePolicy<TStore extends VoicePolicyReadStore>(store: TStore, companyId: string) {
  return store.getSocialVoicePolicy(companyId);
}

export function applySocialVoicePolicy(input: {
  content: string;
  platform: SocialPlatform;
  policy?: SocialVoicePolicy | null;
  brandVoiceProfile?: BrandVoiceProfile | null;
}): AppliedSocialVoicePolicy {
  const content = input.content.trim();
  const restrictedTerms = [
    ...(input.policy?.restrictedTerms ?? []),
    ...(input.brandVoiceProfile?.prohibitedPhrases ?? []),
  ];

  for (const term of restrictedTerms) {
    if (containsRestrictedTerm(content, term)) {
      throw new RestrictedSocialVoiceTermError(term);
    }
  }

  const guidance = buildSocialVoiceGuidance({
    platform: input.platform,
    policy: input.policy,
    brandVoiceProfile: input.brandVoiceProfile,
  });
  return { content, guidance };
}

function buildSocialVoiceGuidance(input: {
  platform: SocialPlatform;
  policy?: SocialVoicePolicy | null;
  brandVoiceProfile?: BrandVoiceProfile | null;
}) {
  const lines: string[] = [];
  if (input.policy) {
    lines.push("Social voice policy:");
    lines.push(`- Tone: ${input.policy.tone}`);
    lines.push(`- Hashtags: ${input.policy.hashtagPolicy}`);
    lines.push(`- Emoji: ${input.policy.emojiPolicy}`);
    const platformGuidance = input.policy.platformGuidance[input.platform];
    if (platformGuidance) lines.push(`- ${input.platform}: ${platformGuidance}`);
    if (input.policy.restrictedTerms.length > 0) {
      lines.push(`- Restricted terms: ${input.policy.restrictedTerms.map((term) => `"${term}"`).join(", ")}`);
    }
  }
  if (input.brandVoiceProfile) {
    lines.push(getBrandVoiceContext(input.brandVoiceProfile));
  }
  return lines.join("\n");
}

function normalizeRestrictedTerms(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("restrictedTerms must be a string array");
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") throw new Error("restrictedTerms must be a string array");
    const term = item.trim();
    if (!term) throw new Error("restrictedTerms must not contain blank values");
    const key = term.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      terms.push(term);
    }
  }
  return terms;
}

function normalizePlatformGuidance(value: unknown) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("platformGuidance must be an object");
  }

  const guidance: SocialVoicePolicyInput["platformGuidance"] = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!(SOCIAL_PLATFORMS as readonly string[]).includes(key)) continue;
    if (typeof raw !== "string") throw new Error("platformGuidance values must be strings");
    const text = raw.trim();
    if (text) guidance[normalizeSocialPlatform(key)] = text;
  }
  return guidance;
}

function requiredString(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function containsRestrictedTerm(content: string, term: string) {
  const cleanTerm = term.trim();
  if (!cleanTerm) return false;
  const escaped = cleanTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\W)${escaped}(?=$|\\W)`, "i").test(content);
}
