import { NextResponse } from "next/server";
import { checkRateLimit, rateLimitExceeded } from "@/lib/rate-limit";
import { recallMissionContext } from "@/lib/gbrain/gbrain-memory";
import { forbidden, getAuthUser, requireRoleForRequest, unauthorized } from "@/lib/session";
import { withRlsContext } from "@/lib/with-rls";

type Params = { params: Promise<{ id: string }> | { id: string } };

// Agents and operators ping this to recall what past missions learned before
// (or while) running a new one. GBrain advises; it never executes.
export async function POST(request: Request, context: Params) {
  const user = await getAuthUser();
  if (!user) return unauthorized();
  const { id: companyId } = await context.params;

  const body = await request.json().catch(() => ({})) as { query?: string; limit?: number };
  const query = body.query?.trim();
  if (!query) return NextResponse.json({ error: "query is required" }, { status: 400 });

  const check = await requireRoleForRequest(user.id, "member", { companyId });
  if (!check.ok) return forbidden();

  const rateLimit = await checkRateLimit(user.id, companyId);
  if (!rateLimit.ok) return rateLimitExceeded(rateLimit.retryAfterSeconds);

  return withRlsContext(companyId, async () => {
    const recall = await recallMissionContext({
      companyId,
      objective: query,
      limit: typeof body.limit === "number" ? body.limit : undefined,
    });
    return NextResponse.json({ recall });
  });
}
