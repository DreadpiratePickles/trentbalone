import { NextResponse } from "next/server";
import { checkRateLimit, rateLimitExceeded } from "@/lib/rate-limit";
import { runAgentMission } from "@/lib/agent-mission-runtime";
import { forbidden, getAuthUser, requireRoleForRequest, unauthorized } from "@/lib/session";
import { store } from "@/lib/store";
import { withRlsContext } from "@/lib/with-rls";

type Params = { params: Promise<{ id: string }> | { id: string } };

export async function GET(_request: Request, context: Params) {
  const user = await getAuthUser();
  if (!user) return unauthorized();
  const { id: companyId } = await context.params;

  const check = await requireRoleForRequest(user.id, "viewer", { companyId });
  if (!check.ok) return forbidden();

  const rateLimit = await checkRateLimit(user.id, companyId);
  if (!rateLimit.ok) return rateLimitExceeded(rateLimit.retryAfterSeconds);

  return withRlsContext(companyId, async () => {
    const missions = await store.listAgentMissionRuns(companyId);
    return NextResponse.json({ missions });
  });
}

export async function POST(request: Request, context: Params) {
  const user = await getAuthUser();
  if (!user) return unauthorized();
  const { id: companyId } = await context.params;
  const body = await request.json().catch(() => ({})) as {
    objective?: string;
    budgetCents?: number;
  };
  const objective = body.objective?.trim();
  if (!objective) return NextResponse.json({ error: "objective is required" }, { status: 400 });

  const check = await requireRoleForRequest(user.id, "member", { companyId });
  if (!check.ok) return forbidden();

  const rateLimit = await checkRateLimit(user.id, companyId);
  if (!rateLimit.ok) return rateLimitExceeded(rateLimit.retryAfterSeconds);

  return withRlsContext(companyId, async () => {
    const result = await runAgentMission({
      companyId,
      objective,
      trigger: "command",
      budgetCents: typeof body.budgetCents === "number" ? body.budgetCents : undefined,
    });
    return NextResponse.json(result, { status: 201 });
  });
}
