import { NextResponse } from "next/server";
import { checkRateLimit, rateLimitExceeded } from "@/lib/rate-limit";
import { getAuthUser, requireRoleForRequest, unauthorized, forbidden } from "@/lib/session";
import { store } from "@/lib/store";
import { withRlsContext } from "@/lib/with-rls";
import {
  createSocialCalendarPosts,
  type SocialAccount,
  type SocialCalendarStore,
  type SocialPost,
} from "@/lib/social/calendar";

type SocialPostsStore = SocialCalendarStore & {
  listSocialPosts(companyId: string): Promise<SocialPost[]>;
  getSocialAccount(companyId: string, socialAccountId: string): Promise<SocialAccount | null | undefined>;
  updateSocialPost(id: string, patch: Partial<SocialPost>): Promise<SocialPost>;
};

type CreatePostsBody = {
  companyId?: unknown;
  socialAccountIds?: unknown;
  content?: unknown;
  mediaUrls?: unknown;
  scheduledFor?: unknown;
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

    const socialStore = requireSocialPostsStore();
    const posts = await socialStore.listSocialPosts(company.id);
    return NextResponse.json({ posts });
  });
}

export async function POST(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const body = await request.json().catch(() => ({})) as CreatePostsBody;
  const parsed = parseCreatePostsBody(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const check = await requireRoleForRequest(user.id, "member", { companyId: parsed.value.companyId });
  if (!check.ok) return forbidden();

  const rateLimit = await checkRateLimit(user.id, parsed.value.companyId);
  if (!rateLimit.ok) return rateLimitExceeded(rateLimit.retryAfterSeconds);

  return withRlsContext(parsed.value.companyId, async () => {
    const company = await store.getCompany(parsed.value.companyId);
    if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });

    const socialStore = requireSocialPostsStore();
    const accounts = await Promise.all(
      parsed.value.socialAccountIds.map((id) => socialStore.getSocialAccount(company.id, id))
    );
    if (accounts.some((account) => !account)) {
      return NextResponse.json({ error: "Social account not found" }, { status: 404 });
    }
    const activeAccounts = accounts.filter(Boolean) as SocialAccount[];

    const result = await createSocialCalendarPosts({
      store: socialStore,
      companyId: company.id,
      accounts: activeAccounts,
      content: parsed.value.content,
      mediaUrls: parsed.value.mediaUrls,
      scheduledFor: parsed.value.scheduledFor,
    });

    return NextResponse.json(result, { status: 201 });
  });
}

function parseCreatePostsBody(body: CreatePostsBody):
  | { ok: true; value: {
    companyId: string;
    socialAccountIds: string[];
    content: string;
    mediaUrls: string[];
    scheduledFor?: string;
  } }
  | { ok: false; error: string } {
  const companyId = requiredString(body.companyId);
  const content = requiredString(body.content);
  if (!companyId || !content) {
    return { ok: false, error: "companyId and content are required" };
  }
  if (!Array.isArray(body.socialAccountIds) || body.socialAccountIds.length === 0) {
    return { ok: false, error: "socialAccountIds must be a non-empty array" };
  }
  const socialAccountIds = body.socialAccountIds.map(requiredString);
  if (socialAccountIds.some((id) => !id)) {
    return { ok: false, error: "socialAccountIds must contain strings" };
  }
  if (body.mediaUrls !== undefined && !Array.isArray(body.mediaUrls)) {
    return { ok: false, error: "mediaUrls must be an array" };
  }
  const mediaUrls = (body.mediaUrls ?? []).map(requiredString);
  if (mediaUrls.some((url) => !url)) {
    return { ok: false, error: "mediaUrls must contain strings" };
  }
  const scheduledFor = body.scheduledFor === undefined ? undefined : requiredString(body.scheduledFor);
  if (body.scheduledFor !== undefined && !scheduledFor) {
    return { ok: false, error: "scheduledFor must be an ISO timestamp string" };
  }
  return {
    ok: true,
    value: {
      companyId,
      socialAccountIds: socialAccountIds as string[],
      content,
      mediaUrls: mediaUrls as string[],
      scheduledFor: scheduledFor ?? undefined,
    },
  };
}

function requiredString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requireSocialPostsStore() {
  const socialStore = store as typeof store & Partial<SocialPostsStore>;
  if (
    typeof socialStore.listSocialPosts !== "function" ||
    typeof socialStore.getSocialAccount !== "function" ||
    typeof socialStore.createSocialPost !== "function" ||
    typeof socialStore.updateSocialPost !== "function" ||
    typeof socialStore.createApproval !== "function"
  ) {
    throw new Error("Social post store methods are not available");
  }
  return socialStore as typeof store & SocialPostsStore;
}
