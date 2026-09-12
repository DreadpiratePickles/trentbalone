import { NextResponse } from "next/server";
import { getVoiceProfile } from "@/lib/brand/voice-memory";
import { checkRateLimit, rateLimitExceeded } from "@/lib/rate-limit";
import { getAuthUser, requireRoleForRequest, unauthorized, forbidden } from "@/lib/session";
import { normalizeSocialPlatform } from "@/lib/social/accounts";
import {
  applySocialVoicePolicy,
  normalizeSocialVoicePolicyInput,
  type SocialVoicePolicy,
  type SocialVoicePolicyInput,
} from "@/lib/social/voice-policy";
import { store } from "@/lib/store";
import { withRlsContext } from "@/lib/with-rls";

type SocialVoicePolicyStore = {
  getSocialVoicePolicy(companyId: string): Promise<SocialVoicePolicy | null | undefined>;
  upsertSocialVoicePolicy(input: SocialVoicePolicyInput): Promise<SocialVoicePolicy>;
};

export async function GET(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const companyId = new URL(request.url).searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId is required" }, { status: 400 });

  const check = await requireRoleForRequest(user.id, "viewer", { companyId });
  if (!check.ok) return forbidden();

  const rateLimit = await checkRateLimit(user.id, companyId);
  if (!rateLimit.ok) return rateLimitExceeded(rateLimit.retryAfterSeconds);

  return withRlsContext(companyId, async () => {
    const company = await store.getCompany(companyId);
    if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });

    const socialStore = requireSocialVoicePolicyStore();
    const [policy, brandVoice] = await Promise.all([
      socialStore.getSocialVoicePolicy(company.id),
      getVoiceProfile(company.id),
    ]);
    return NextResponse.json({ policy: policy ?? null, brandVoice });
  });
}

export async function POST(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  let input: SocialVoicePolicyInput;
  try {
    input = normalizeSocialVoicePolicyInput(body);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid request" }, { status: 400 });
  }

  const check = await requireRoleForRequest(user.id, "member", { companyId: input.companyId });
  if (!check.ok) return forbidden();

  const rateLimit = await checkRateLimit(user.id, input.companyId);
  if (!rateLimit.ok) return rateLimitExceeded(rateLimit.retryAfterSeconds);

  return withRlsContext(input.companyId, async () => {
    const company = await store.getCompany(input.companyId);
    if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });

    const brandVoice = await getVoiceProfile(company.id);
    if (body.content !== undefined) {
      if (typeof body.content !== "string" || !body.content.trim()) {
        return NextResponse.json({ error: "content must be a non-empty string" }, { status: 400 });
      }
      if (body.platform === undefined) {
        return NextResponse.json({ error: "platform is required when content is provided" }, { status: 400 });
      }
      try {
        applySocialVoicePolicy({
          content: body.content,
          platform: normalizeSocialPlatform(body.platform),
          policy: { ...input, id: "pending", createdAt: "", updatedAt: "" },
          brandVoiceProfile: brandVoice,
        });
      } catch (error) {
        return NextResponse.json(
          { error: error instanceof Error ? error.message : "Content violates social voice policy" },
          { status: 400 },
        );
      }
    }

    const socialStore = requireSocialVoicePolicyStore();
    const policy = await socialStore.upsertSocialVoicePolicy({ ...input, companyId: company.id });
    return NextResponse.json({ policy, brandVoice });
  });
}

function requireSocialVoicePolicyStore() {
  const socialStore = store as typeof store & Partial<SocialVoicePolicyStore>;
  if (
    typeof socialStore.getSocialVoicePolicy !== "function" ||
    typeof socialStore.upsertSocialVoicePolicy !== "function"
  ) {
    throw new Error("Social voice policy store methods are not available");
  }
  return socialStore as typeof store & SocialVoicePolicyStore;
}
