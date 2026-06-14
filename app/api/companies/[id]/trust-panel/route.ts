import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit, rateLimitExceeded } from "@/lib/rate-limit";
import { forbidden, getAuthUser, requireRoleForRequest, unauthorized } from "@/lib/session";
import {
  buildTrustPanelView,
  seedTrustPanelProofEvidence,
  type TrustPanelScenario,
} from "@/lib/trust-panel-view";
import { withRlsContext } from "@/lib/with-rls";
import type { AgentRole } from "@/lib/types";

function parseScenario(value: string | null): TrustPanelScenario {
  return value === "blocked" ? "blocked" : "clean";
}

function parseSeat(value: string | null): AgentRole {
  if (value === "engineer" || value === "analyst" || value === "ceo") return value;
  return "growth";
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id: companyId } = await params;
  const check = await requireRoleForRequest(user.id, "viewer", { companyId });
  if (!check.ok) return forbidden();

  const rateLimit = await checkRateLimit(user.id, companyId);
  if (!rateLimit.ok) return rateLimitExceeded(rateLimit.retryAfterSeconds);

  const scenario = parseScenario(request.nextUrl.searchParams.get("scenario"));
  const seat = parseSeat(request.nextUrl.searchParams.get("seat"));

  return withRlsContext(companyId, async () => {
    const panel = await buildTrustPanelView({ companyId, scenario, seat });
    return NextResponse.json({ panel });
  });
}

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (process.env.NODE_ENV !== "development") {
    return NextResponse.json({ error: "Proof seed is development-only" }, { status: 403 });
  }

  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id: companyId } = await params;
  const check = await requireRoleForRequest(user.id, "member", { companyId });
  if (!check.ok) return forbidden();

  return withRlsContext(companyId, async () => {
    await seedTrustPanelProofEvidence(companyId);
    return NextResponse.json({ ok: true, companyId });
  });
}
