import { NextResponse } from "next/server";
import { checkRateLimit, rateLimitExceeded } from "@/lib/rate-limit";
import { forbidden, getAuthUser, requireRoleForRequest, unauthorized } from "@/lib/session";
import { canCompanySeePlug } from "@/lib/plug/schema-v2";
import { listLaunchPlugs } from "@/lib/plug/registry";
import { rankPlugs } from "@/lib/plug/ranking";
import { withRlsContext } from "@/lib/with-rls";

export async function GET(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const url = new URL(request.url);
  const companyId = url.searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId is required" }, { status: 400 });

  const role = await requireRoleForRequest(user.id, "viewer", { companyId });
  if (!role.ok) return forbidden();

  const limit = await checkRateLimit(user.id, companyId);
  if (!limit.ok) return rateLimitExceeded(limit.retryAfterSeconds);

  return withRlsContext(companyId, async () => {
    const category = url.searchParams.get("category");
    const creator = url.searchParams.get("creator");
    const outcome = url.searchParams.get("outcome");
    const industry = url.searchParams.get("industry");
    const minEvalScore = parseOptionalScore(url.searchParams.get("eval-score") ?? url.searchParams.get("minEvalScore"));
    const plugs = rankPlugs(
      listLaunchPlugs()
        .filter((plug) => canCompanySeePlug(plug, companyId))
        .filter((plug) => !category || plug.category === category)
        .filter((plug) => !industry || plug.industry === industry)
        .filter((plug) => !creator || plug.publisher.id === creator)
        .filter((plug) => minEvalScore === undefined || plug.evalSet.lastScore >= minEvalScore)
        .filter((plug) => plugMatchesOutcome(plug.completionRate, outcome))
    );
    return NextResponse.json({ plugs });
  });
}

function parseOptionalScore(raw: string | null) {
  if (!raw) return undefined;
  const score = Number(raw);
  return Number.isFinite(score) ? score : undefined;
}

function plugMatchesOutcome(completionRate: number, outcome: string | null) {
  if (!outcome) return true;
  if (outcome === "high_completion") return completionRate >= 0.9;
  if (outcome === "proven") return completionRate >= 0.85;
  return true;
}
