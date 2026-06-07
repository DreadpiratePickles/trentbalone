import { NextResponse } from "next/server";
import {
  listCreativeConnectionStatuses,
  normalizeCreativeConnectionInput,
  saveCreativeConnection,
} from "@/lib/creative-connections";
import { checkRateLimit, rateLimitExceeded } from "@/lib/rate-limit";
import { forbidden, getAuthUser, requireRoleForRequest, unauthorized } from "@/lib/session";
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

    const connections = await listCreativeConnectionStatuses(company.id);
    return NextResponse.json({ connections });
  });
}

export async function POST(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const body = await request.json().catch(() => ({}));
  let input;
  try {
    input = normalizeCreativeConnectionInput(body);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid request" }, { status: 400 });
  }

  const check = await requireRoleForRequest(user.id, "admin", { companyId: input.companyId });
  if (!check.ok) return forbidden();

  const rateLimit = await checkRateLimit(user.id, input.companyId);
  if (!rateLimit.ok) return rateLimitExceeded(rateLimit.retryAfterSeconds);

  return withRlsContext(input.companyId, async () => {
    const company = await store.getCompany(input.companyId);
    if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });

    const connection = await saveCreativeConnection(company.id, { app: input.app, apiKey: input.apiKey });
    const [safeConnection] = (await listCreativeConnectionStatuses(company.id))
      .filter((item) => item.provider === connection.provider);
    return NextResponse.json({ connection: safeConnection }, { status: 201 });
  });
}
