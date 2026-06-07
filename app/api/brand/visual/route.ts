import { NextResponse } from "next/server";
import { store } from "@/lib/store";
import { getAuthUser, unauthorized, forbidden, requireRoleForRequest } from "@/lib/session";
import { checkRateLimit, rateLimitExceeded } from "@/lib/rate-limit";
import { withRlsContext } from "@/lib/with-rls";
import { getVisualProfile, setVisualProfile } from "@/lib/brand/visual-memory";

export async function GET(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const companyId = new URL(request.url).searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId is required" }, { status: 400 });

  const company = await store.getCompany(companyId);
  if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });

  const check = await requireRoleForRequest(user.id, "viewer", { companyId: company.id });
  if (!check.ok) return forbidden();

  const rateLimit = await checkRateLimit(user.id, company.id);
  if (!rateLimit.ok) return rateLimitExceeded(rateLimit.retryAfterSeconds);

  return withRlsContext(company.id, async () => {
    const profile = await getVisualProfile(company.id);
    return NextResponse.json({ profile });
  });
}

export async function POST(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  if (typeof body.companyId !== "string" || !body.companyId.trim()) {
    return NextResponse.json({ error: "companyId is required" }, { status: 400 });
  }

  const palette = parseStringArray(body.palette ?? []);
  const typography = parseStringArray(body.typography ?? []);
  const referenceImageUrls = parseStringArray(body.referenceImageUrls ?? []);
  const negativeTerms = parseStringArray(body.negativeTerms ?? []);
  if (!palette || !typography || !referenceImageUrls || !negativeTerms) {
    return NextResponse.json({ error: "visual profile fields must be string arrays" }, { status: 400 });
  }

  const company = await store.getCompany(body.companyId.trim());
  if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });

  const check = await requireRoleForRequest(user.id, "member", { companyId: company.id });
  if (!check.ok) return forbidden();

  const rateLimit = await checkRateLimit(user.id, company.id);
  if (!rateLimit.ok) return rateLimitExceeded(rateLimit.retryAfterSeconds);

  return withRlsContext(company.id, async () => {
    const profile = await setVisualProfile(company.id, {
      logoUrl: optionalString(body.logoUrl),
      palette,
      typography,
      referenceImageUrls,
      negativeTerms,
    });
    return NextResponse.json({ profile });
  });
}

function parseStringArray(value: unknown) {
  if (!Array.isArray(value)) return null;
  const strings = value
    .filter((item): item is string => typeof item === "string")
    .map(item => item.trim())
    .filter(Boolean);
  return strings.length === value.length ? strings : null;
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
