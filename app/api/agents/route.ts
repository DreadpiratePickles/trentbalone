import { NextResponse } from "next/server";
import { store } from "@/lib/store";
import { getAuthUser, unauthorized, forbidden, requireRoleForRequest } from "@/lib/session";
import { checkRateLimit, rateLimitExceeded } from "@/lib/rate-limit";

export async function GET(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const companyId = new URL(request.url).searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId is required" }, { status: 400 });
  
  const check = await requireRoleForRequest(user.id, "viewer", { companyId });
  if (!check.ok) return forbidden();

  const rateLimit = await checkRateLimit(user.id, companyId);
  if (!rateLimit.ok) return rateLimitExceeded(rateLimit.retryAfterSeconds);

  return NextResponse.json({ agents: await store.listAgents(companyId) });
}

export async function PATCH(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const body = await request.clone().json().catch(() => ({}));
  if (!body.id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  const existing = await store.getAgent(body.id);
  if (!existing) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  
  const check = await requireRoleForRequest(user.id, "admin", { companyId: existing.companyId });
  if (!check.ok) return forbidden();

  const rateLimit = await checkRateLimit(user.id, existing.companyId);
  if (!rateLimit.ok) return rateLimitExceeded(rateLimit.retryAfterSeconds);

  const agent = await store.updateAgent(body.id, body);
  return NextResponse.json({ agent });
}

