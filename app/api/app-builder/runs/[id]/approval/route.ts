import { NextResponse } from "next/server";
import { checkRateLimit, rateLimitExceeded } from "@/lib/rate-limit";
import { getAuthUser, requireRoleForRequest, unauthorized, forbidden } from "@/lib/session";
import { store } from "@/lib/store";
import { createReleaseApproval, createReleasePlanCard } from "@/lib/app-builder/supervision";
import { withRlsContext } from "@/lib/with-rls";
import type { AppBuilderReleaseTarget } from "@/lib/app-builder/supervision";

type Params = { params: Promise<{ id: string }> | { id: string } };

export async function POST(request: Request, context: Params) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id } = await context.params;
  const companyId = new URL(request.url).searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId is required" }, { status: 400 });

  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const target = body.target === "pr" || body.target === "deploy" ? body.target : undefined;
  if (!target) return NextResponse.json({ error: "target must be pr or deploy" }, { status: 400 });

  const check = await requireRoleForRequest(user.id, "member", { companyId });
  if (!check.ok) return forbidden();

  const rateLimit = await checkRateLimit(user.id, companyId);
  if (!rateLimit.ok) return rateLimitExceeded(rateLimit.retryAfterSeconds);

  return withRlsContext(companyId, async () => {
    const session = await store.getWorkbenchSession(id);
    if (!session || session.companyId !== companyId || !session.objective.startsWith("App Builder:")) {
      return NextResponse.json({ error: "App builder run not found" }, { status: 404 });
    }

    const card = createReleasePlanCard({
      runId: session.id,
      target: target as AppBuilderReleaseTarget,
      previewUrl: session.previewUrl,
      estimatedCostCents: intValue(body.estimatedCostCents) ?? 0,
      rollbackTarget: stringValue(body.rollbackTarget),
    });
    const approval = await createReleaseApproval({ store, companyId, card });
    return NextResponse.json({ card, approval }, { status: 201 });
  });
}

function intValue(value: unknown) {
  return Number.isInteger(value) && (value as number) >= 0 ? value as number : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
