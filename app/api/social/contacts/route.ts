import { NextResponse } from "next/server";
import { checkRateLimit, rateLimitExceeded } from "@/lib/rate-limit";
import { getAuthUser, requireRoleForRequest, unauthorized, forbidden } from "@/lib/session";
import { updateSocialContactMemory } from "@/lib/social/inbox";
import type {
  SocialContact,
  SocialContactEngagementState,
  SocialContactOptOutStatus,
  SocialContactPatch,
} from "@/lib/social/types";
import { store } from "@/lib/store";
import { withRlsContext } from "@/lib/with-rls";

type SocialContactsStore = {
  listSocialContacts(companyId: string): Promise<SocialContact[]>;
  getSocialContact(companyId: string, contactId: string): Promise<SocialContact | undefined | null>;
  updateSocialContact(companyId: string, contactId: string, patch: SocialContactPatch): Promise<SocialContact | undefined | null>;
};

type ContactUpdateBody = {
  companyId?: unknown;
  contactId?: unknown;
  memory?: unknown;
  engagementState?: unknown;
  optOutStatus?: unknown;
};

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

    const contacts = await requireSocialContactsStore().listSocialContacts(company.id);
    return NextResponse.json({ contacts });
  });
}

export async function POST(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const body = await request.json().catch(() => ({})) as ContactUpdateBody;
  const parsed = parseContactUpdateBody(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const check = await requireRoleForRequest(user.id, "member", { companyId: parsed.value.companyId });
  if (!check.ok) return forbidden();

  const rateLimit = await checkRateLimit(user.id, parsed.value.companyId);
  if (!rateLimit.ok) return rateLimitExceeded(rateLimit.retryAfterSeconds);

  return withRlsContext(parsed.value.companyId, async () => {
    const company = await store.getCompany(parsed.value.companyId);
    if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });

    try {
      const contact = await updateSocialContactMemory(requireSocialContactsStore(), {
        companyId: company.id,
        contactId: parsed.value.contactId,
        memory: parsed.value.memory,
        engagementState: parsed.value.engagementState,
        optOutStatus: parsed.value.optOutStatus,
      });
      return NextResponse.json({ contact });
    } catch (error) {
      return NextResponse.json({ error: (error as Error).message }, { status: 404 });
    }
  });
}

function parseContactUpdateBody(body: ContactUpdateBody):
  | { ok: true; value: {
    companyId: string;
    contactId: string;
    memory: Record<string, unknown>;
    engagementState?: SocialContactEngagementState;
    optOutStatus?: SocialContactOptOutStatus;
  } }
  | { ok: false; error: string } {
  const companyId = requiredString(body.companyId);
  const contactId = requiredString(body.contactId);
  if (!companyId || !contactId) return { ok: false, error: "companyId and contactId are required" };
  if (!isRecord(body.memory)) return { ok: false, error: "memory must be an object" };

  const parsedEngagementState = body.engagementState === undefined ? undefined : requiredEngagementState(body.engagementState);
  if (body.engagementState !== undefined && !parsedEngagementState) {
    return { ok: false, error: "engagementState is invalid" };
  }
  const parsedOptOutStatus = body.optOutStatus === undefined ? undefined : requiredOptOutStatus(body.optOutStatus);
  if (body.optOutStatus !== undefined && !parsedOptOutStatus) {
    return { ok: false, error: "optOutStatus is invalid" };
  }
  const engagementState = parsedEngagementState ?? undefined;
  const optOutStatus = parsedOptOutStatus ?? undefined;

  return { ok: true, value: { companyId, contactId, memory: body.memory, engagementState, optOutStatus } };
}

function requiredString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredEngagementState(value: unknown): SocialContactEngagementState | null {
  return typeof value === "string" && ["unknown", "contacted", "engaged", "qualified", "muted"].includes(value)
    ? value as SocialContactEngagementState
    : null;
}

function requiredOptOutStatus(value: unknown): SocialContactOptOutStatus | null {
  return typeof value === "string" && ["not_opted_out", "opted_out"].includes(value)
    ? value as SocialContactOptOutStatus
    : null;
}

function requireSocialContactsStore() {
  const socialStore = store as typeof store & Partial<SocialContactsStore>;
  if (
    typeof socialStore.listSocialContacts !== "function" ||
    typeof socialStore.getSocialContact !== "function" ||
    typeof socialStore.updateSocialContact !== "function"
  ) {
    throw new Error("Social contact store methods are not available");
  }
  return socialStore as typeof store & SocialContactsStore;
}
