import { NextResponse } from "next/server";
import { checkRateLimit, rateLimitExceeded } from "@/lib/rate-limit";
import {
  getGbrainConnectionStatus,
  normalizeGbrainConnectionInput,
  saveGbrainConnection,
} from "@/lib/gbrain/gbrain-connections";
import { forbidden, getAuthUser, requireRoleForRequest, unauthorized } from "@/lib/session";
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
    const connection = await getGbrainConnectionStatus(companyId);
    return NextResponse.json({ connection });
  });
}

export async function POST(request: Request, context: Params) {
  const user = await getAuthUser();
  if (!user) return unauthorized();
  const { id: companyId } = await context.params;

  const body = await request.json().catch(() => ({}));
  let input;
  try {
    input = normalizeGbrainConnectionInput({ ...body, companyId });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid request" }, { status: 400 });
  }

  const check = await requireRoleForRequest(user.id, "admin", { companyId });
  if (!check.ok) return forbidden();

  const rateLimit = await checkRateLimit(user.id, companyId);
  if (!rateLimit.ok) return rateLimitExceeded(rateLimit.retryAfterSeconds);

  return withRlsContext(companyId, async () => {
    await saveGbrainConnection(companyId, { baseUrl: input.baseUrl, apiKey: input.apiKey });
    const connection = await getGbrainConnectionStatus(companyId);
    return NextResponse.json({ connection }, { status: 201 });
  });
}
