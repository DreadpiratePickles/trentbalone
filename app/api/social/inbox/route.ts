import { NextResponse } from "next/server";
import { checkRateLimit, rateLimitExceeded } from "@/lib/rate-limit";
import { getAuthUser, requireRoleForRequest, unauthorized, forbidden } from "@/lib/session";
import { listUnifiedInbox, type SocialInboxReadStore } from "@/lib/social/inbox";
import { store } from "@/lib/store";
import { withRlsContext } from "@/lib/with-rls";

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

    const inbox = await listUnifiedInbox(requireSocialInboxStore(), company.id);
    return NextResponse.json({ inbox });
  });
}

function requireSocialInboxStore() {
  const socialStore = store as typeof store & Partial<SocialInboxReadStore>;
  if (
    typeof socialStore.listSocialConversations !== "function" ||
    typeof socialStore.getSocialContact !== "function" ||
    typeof socialStore.listSocialMessagesForConversation !== "function"
  ) {
    throw new Error("Social inbox store methods are not available");
  }
  return socialStore as typeof store & SocialInboxReadStore;
}
