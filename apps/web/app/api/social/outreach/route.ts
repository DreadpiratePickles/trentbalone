import { NextResponse } from "next/server";
import { checkRateLimit, rateLimitExceeded } from "@/lib/rate-limit";
import { getAuthUser, requireRoleForRequest, unauthorized, forbidden } from "@/lib/session";
import { createPersonalizedOutreachDraft, type SocialOutreachContact, type SocialOutreachStore } from "@/lib/social/outreach";
import { SOCIAL_PLATFORMS, type SocialPlatform } from "@/lib/social/types";
import { store } from "@/lib/store";
import { withRlsContext } from "@/lib/with-rls";

type OutreachRouteStore = SocialOutreachStore & {
  getCompany(companyId: string): Promise<{ id: string } | null | undefined>;
};

type OutreachBody = {
  companyId?: unknown;
  purpose?: unknown;
  context?: unknown;
  senderName?: unknown;
  contact?: unknown;
};

export async function POST(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const body = await request.json().catch(() => ({})) as OutreachBody;
  const parsed = parseOutreachBody(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const check = await requireRoleForRequest(user.id, "member", { companyId: parsed.value.companyId });
  if (!check.ok) return forbidden();

  const rateLimit = await checkRateLimit(user.id, parsed.value.companyId);
  if (!rateLimit.ok) return rateLimitExceeded(rateLimit.retryAfterSeconds);

  return withRlsContext(parsed.value.companyId, async () => {
    const socialStore = requireOutreachStore();
    const company = await socialStore.getCompany(parsed.value.companyId);
    if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });

    try {
      const result = await createPersonalizedOutreachDraft({
        store: socialStore,
        companyId: company.id,
        contact: parsed.value.contact,
        purpose: parsed.value.purpose,
        context: parsed.value.context,
        senderName: parsed.value.senderName,
      });
      return NextResponse.json(result, { status: 201 });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to create outreach draft";
      const status = message.includes("opted out") || message.includes("No double-DM") ? 409 : 400;
      return NextResponse.json({ error: message }, { status });
    }
  });
}

function parseOutreachBody(body: OutreachBody):
  | { ok: true; value: {
    companyId: string;
    purpose: string;
    context?: string;
    senderName?: string;
    contact: SocialOutreachContact;
  } }
  | { ok: false; error: string } {
  const companyId = requiredString(body.companyId);
  const purpose = requiredString(body.purpose);
  if (!companyId || !purpose) return { ok: false, error: "companyId and purpose are required" };
  if (!isRecord(body.contact)) return { ok: false, error: "contact is required" };

  const id = requiredString(body.contact.id);
  const contactCompanyId = requiredString(body.contact.companyId);
  const platform = normalizePlatform(body.contact.platform);
  const externalContactId = requiredString(body.contact.externalContactId);
  if (!id || !contactCompanyId || !platform || !externalContactId) {
    return { ok: false, error: "contact id, companyId, platform, and externalContactId are required" };
  }

  const contact: SocialOutreachContact = {
    id,
    companyId: contactCompanyId,
    platform,
    externalContactId,
    handle: optionalString(body.contact.handle),
    displayName: optionalString(body.contact.displayName),
    profileUrl: optionalString(body.contact.profileUrl),
    engagementState: optionalString(body.contact.engagementState) ?? "unknown",
    optOutStatus: optionalString(body.contact.optOutStatus) ?? "not_opted_out",
    lastOutboundAt: optionalString(body.contact.lastOutboundAt),
    lastInboundAt: optionalString(body.contact.lastInboundAt),
    memory: isRecord(body.contact.memory) ? body.contact.memory : {},
  };

  return {
    ok: true,
    value: {
      companyId,
      purpose,
      context: optionalString(body.context),
      senderName: optionalString(body.senderName),
      contact,
    },
  };
}

function requiredString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePlatform(value: unknown): SocialPlatform | null {
  if (typeof value !== "string") return null;
  const normalized = value.toLowerCase().trim();
  return SOCIAL_PLATFORMS.includes(normalized as SocialPlatform) ? normalized as SocialPlatform : null;
}

function requireOutreachStore() {
  const socialStore = store as typeof store & Partial<OutreachRouteStore>;
  if (
    typeof socialStore.getCompany !== "function" ||
    typeof socialStore.createSocialOutreachDraft !== "function" ||
    typeof socialStore.updateSocialOutreachDraft !== "function" ||
    typeof socialStore.createApproval !== "function"
  ) {
    throw new Error("Social outreach store methods are not available");
  }
  return socialStore as typeof store & OutreachRouteStore;
}
