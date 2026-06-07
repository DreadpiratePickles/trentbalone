import { NextResponse } from "next/server";
import { checkRateLimit, rateLimitExceeded } from "@/lib/rate-limit";
import { getAuthUser, requireRoleForRequest, unauthorized, forbidden } from "@/lib/session";
import { store } from "@/lib/store";
import {
  ServerEventAccountConfigurationError,
  ServerEventAccountNotFoundError,
  ServerEventConflictError,
  ServerEventConsentRequiredError,
  buildServerEvent,
  sendServerEvent,
} from "@/lib/marketing/capi";
import { withRlsContext } from "@/lib/with-rls";

type EventBody = {
  companyId?: unknown;
  marketingAccountId?: unknown;
  eventName?: unknown;
  eventId?: unknown;
  occurredAt?: unknown;
  sourceUrl?: unknown;
  fbp?: unknown;
  fbc?: unknown;
  email?: unknown;
  phone?: unknown;
};

export async function POST(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const body = await request.json().catch(() => ({})) as EventBody;
  const companyId = requiredString(body.companyId);
  const marketingAccountId = requiredString(body.marketingAccountId);
  if (!companyId || !marketingAccountId) {
    return NextResponse.json({ error: "companyId and marketingAccountId are required" }, { status: 400 });
  }

  const check = await requireRoleForRequest(user.id, "member", { companyId });
  if (!check.ok) return forbidden();

  const rateLimit = await checkRateLimit(user.id, companyId);
  if (!rateLimit.ok) return rateLimitExceeded(rateLimit.retryAfterSeconds);

  let event;
  try {
    event = buildServerEvent({
      eventName: body.eventName,
      eventId: body.eventId,
      occurredAt: body.occurredAt,
      sourceUrl: body.sourceUrl,
      fbp: body.fbp,
      fbc: body.fbc,
      email: body.email,
      phone: body.phone,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid event" }, { status: 400 });
  }

  return withRlsContext(companyId, async () => {
    const company = await store.getCompany(companyId);
    if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });

    const existing = await store.getConversionEventByEventId(event.eventId);
    if (existing) {
      if (existing.companyId !== companyId) {
        return NextResponse.json({ error: "Conversion event eventId already exists" }, { status: 409 });
      }
      return NextResponse.json({ event: existing });
    }

    try {
      const conversionEvent = await sendServerEvent(company.id, marketingAccountId, event);
      return NextResponse.json({ event: conversionEvent }, { status: 201 });
    } catch (error) {
      if (error instanceof ServerEventConsentRequiredError) {
        return NextResponse.json({ error: error.message }, { status: 409 });
      }
      if (error instanceof ServerEventConflictError) {
        return NextResponse.json({ error: error.message }, { status: 409 });
      }
      if (error instanceof ServerEventAccountNotFoundError) {
        return NextResponse.json({ error: error.message }, { status: 404 });
      }
      if (error instanceof ServerEventAccountConfigurationError) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      throw error;
    }
  });
}

function requiredString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
