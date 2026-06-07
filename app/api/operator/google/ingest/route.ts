import { NextResponse } from "next/server";
import { checkRateLimit, rateLimitExceeded } from "@/lib/rate-limit";
import { forbidden, getAuthUser, unauthorized } from "@/lib/session";
import { isOperator } from "@/lib/google/operator-auth";
import { OPERATOR_SCOPE } from "@/lib/google/google-connection";
import { ingestGoogleContext } from "@/lib/google/google-memory";

// Pull the operator's recent Gmail + Calendar into GBrain memory. Read-only.
export async function POST(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();
  if (!isOperator(user.email)) return forbidden();

  const rateLimit = await checkRateLimit(user.id, OPERATOR_SCOPE);
  if (!rateLimit.ok) return rateLimitExceeded(rateLimit.retryAfterSeconds);

  const body = await request.json().catch(() => ({})) as { emailLimit?: number; eventLimit?: number };
  const result = await ingestGoogleContext({
    emailLimit: typeof body.emailLimit === "number" ? body.emailLimit : undefined,
    eventLimit: typeof body.eventLimit === "number" ? body.eventLimit : undefined,
  });
  return NextResponse.json({ result });
}
