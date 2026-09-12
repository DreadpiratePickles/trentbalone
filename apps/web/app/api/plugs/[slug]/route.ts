import { NextResponse } from "next/server";
import { checkRateLimit, rateLimitExceeded } from "@/lib/rate-limit";
import { composePlugs } from "@/lib/plug/composition";
import { findPlugBySlug, listLaunchPlugs } from "@/lib/plug/registry";
import { rankPlugs } from "@/lib/plug/ranking";
import { reviewPlugSecurity } from "@/lib/plug/security-review";
import { canCompanySeePlug } from "@/lib/plug/schema-v2";
import { forbidden, getAuthUser, requireRoleForRequest, unauthorized } from "@/lib/session";
import { withRlsContext } from "@/lib/with-rls";

type Ctx = { params: Promise<{ slug: string }> };

export async function GET(request: Request, ctx: Ctx) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const url = new URL(request.url);
  const companyId = url.searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId is required" }, { status: 400 });

  const role = await requireRoleForRequest(user.id, "viewer", { companyId });
  if (!role.ok) return forbidden();

  const limit = await checkRateLimit(user.id, companyId);
  if (!limit.ok) return rateLimitExceeded(limit.retryAfterSeconds);

  const { slug } = await ctx.params;
  return withRlsContext(companyId, async () => {
    const plug = findPlugBySlug(slug);
    if (!plug || !canCompanySeePlug(plug, companyId)) return NextResponse.json({ error: "Plug not found" }, { status: 404 });
    return NextResponse.json({
      plug,
      security: reviewPlugSecurity(plug),
      ranking: rankPlugs([plug])[0],
      compositionPreview: composePlugs([plug], { maxDepth: 3, budgetCents: plug.costPerRunCents }),
      related: rankPlugs(listLaunchPlugs().filter((candidate) => candidate.category === plug.category && candidate.slug !== plug.slug)).slice(0, 3),
    });
  });
}
