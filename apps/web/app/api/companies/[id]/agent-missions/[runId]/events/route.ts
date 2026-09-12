import { NextResponse } from "next/server";
import { checkRateLimit, rateLimitExceeded } from "@/lib/rate-limit";
import { forbidden, getAuthUser, requireRoleForRequest, unauthorized } from "@/lib/session";
import { store } from "@/lib/store";
import { withRlsContext } from "@/lib/with-rls";

type Params = { params: Promise<{ id: string; runId: string }> | { id: string; runId: string } };

export async function GET(_request: Request, context: Params) {
  const user = await getAuthUser();
  if (!user) return unauthorized();
  const { id: companyId, runId } = await context.params;

  const check = await requireRoleForRequest(user.id, "viewer", { companyId });
  if (!check.ok) return forbidden();

  const rateLimit = await checkRateLimit(user.id, companyId);
  if (!rateLimit.ok) return rateLimitExceeded(rateLimit.retryAfterSeconds);

  return withRlsContext(companyId, async () => {
    const run = await store.getAgentMissionRun(runId);
    if (!run || run.companyId !== companyId) {
      return NextResponse.json({ error: "Agent mission not found" }, { status: 404 });
    }
    const events = await store.listAgentMissionEvents(run.id);
    return NextResponse.json({ events });
  });
}
