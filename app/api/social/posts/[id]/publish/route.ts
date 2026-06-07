import { NextResponse } from "next/server";
import { checkRateLimit, rateLimitExceeded } from "@/lib/rate-limit";
import { getAuthUser, requireRoleForRequest, unauthorized, forbidden } from "@/lib/session";
import { store } from "@/lib/store";
import { withRlsContext } from "@/lib/with-rls";
import { assertContentMissionExternalActionAllowed } from "@/lib/content-mission-approvals";
import { buildPlatformAuthReadiness } from "@/lib/platform-auth-readiness";
import { markContentMissionActionExecuted } from "@/lib/content-mission-store";
import { assertPublishingAllowed, type ApprovalLike } from "@/lib/social/calendar";
import { getSocialPlatformAdapter } from "@/lib/social/platform-adapter";
import type { Approval } from "@/lib/types";
import type { SocialAccount, SocialPost } from "@/lib/social/types";

type PublishParams = {
  params: Promise<{ id: string }> | { id: string };
};

type SocialPublishStore = {
  getSocialPost(id: string): Promise<SocialPost | null | undefined>;
  getSocialAccount(companyId: string, socialAccountId: string): Promise<SocialAccount | null | undefined>;
  getApproval(id: string): Promise<ApprovalLike | null | undefined>;
  listApprovals(companyId: string): Promise<Approval[]>;
  updateSocialPost(id: string, patch: Partial<SocialPost>): Promise<SocialPost>;
};

export async function POST(request: Request, context: PublishParams) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id } = await context.params;
  const companyId = new URL(request.url).searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId is required" }, { status: 400 });

  const check = await requireRoleForRequest(user.id, "member", { companyId });
  if (!check.ok) return forbidden();

  const rateLimit = await checkRateLimit(user.id, companyId);
  if (!rateLimit.ok) return rateLimitExceeded(rateLimit.retryAfterSeconds);

  return withRlsContext(companyId, async () => {
    const socialStore = requireSocialPublishStore();
    const post = await socialStore.getSocialPost(id);
    if (!post || post.companyId !== companyId) {
      return NextResponse.json({ error: "Social post not found" }, { status: 404 });
    }

    const account = await socialStore.getSocialAccount(companyId, post.socialAccountId);
    if (!account) return NextResponse.json({ error: "Social account not found" }, { status: 404 });

    const approval = post.approvalId ? await socialStore.getApproval(post.approvalId) : null;
    try {
      await assertPublishingAllowed({ post, account, approval });
      const contentMissionRunId = getContentMissionRunId(post);
      if (contentMissionRunId) {
        await assertContentMissionPublishingAllowed({
          companyId,
          runId: contentMissionRunId,
          post,
          account,
          store: socialStore,
        });
      }
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Publishing is not allowed" },
        { status: 403 }
      );
    }

    const adapter = getSocialPlatformAdapter(post.platform);
    if (!adapter.capabilities.posts) {
      return NextResponse.json({ error: "Social platform does not support post publishing" }, { status: 400 });
    }
    const published = await adapter.publishPost({
      companyId,
      postId: post.id,
      socialAccountId: account.id,
      externalAccountId: account.externalAccountId,
      content: post.content,
      mediaUrls: post.mediaUrls,
      approvalId: post.approvalId,
    });
    const updated = await socialStore.updateSocialPost(post.id, {
      status: "published",
      externalPostId: published.externalPostId,
      publishedAt: published.publishedAt,
    });

    const contentMissionRunId = getContentMissionRunId(post);
    if (contentMissionRunId) {
      await markContentMissionActionExecuted({
        runId: contentMissionRunId,
        kind: "public_publish",
        externalRef: published.externalPostId,
      }).catch(() => undefined);
    }

    return NextResponse.json({ post: updated, published });
  });
}

function requireSocialPublishStore() {
  const socialStore = store as typeof store & Partial<SocialPublishStore>;
  if (
    typeof socialStore.getSocialPost !== "function" ||
    typeof socialStore.getSocialAccount !== "function" ||
    typeof socialStore.getApproval !== "function" ||
    typeof socialStore.listApprovals !== "function" ||
    typeof socialStore.updateSocialPost !== "function"
  ) {
    throw new Error("Social publishing store methods are not available");
  }
  return socialStore as typeof store & SocialPublishStore;
}

async function assertContentMissionPublishingAllowed(input: {
  companyId: string;
  runId: string;
  post: SocialPost;
  account: SocialAccount;
  store: SocialPublishStore;
}) {
  const approvals = await input.store.listApprovals(input.companyId);
  assertContentMissionExternalActionAllowed({
    companyId: input.companyId,
    runId: input.runId,
    kind: "public_publish",
    approvals,
    platformReadiness: buildPlatformAuthReadiness({
      socialAccounts: [input.account],
      requiredSocialPlatforms: [input.post.platform],
      socialPublishingRequested: true,
    }),
  });
}

function getContentMissionRunId(post: SocialPost): string | undefined {
  const metadata = post.metadata ?? {};
  const direct = metadata.contentMissionRunId;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const nested = metadata.contentMission;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const runId = (nested as { runId?: unknown }).runId;
    if (typeof runId === "string" && runId.trim()) return runId.trim();
  }
  return undefined;
}
