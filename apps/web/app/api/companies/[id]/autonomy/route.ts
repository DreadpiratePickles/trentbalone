import { NextResponse } from "next/server";
import { forbidden, getAuthUser, requireRoleForRequest, unauthorized } from "@/lib/session";
import { withRlsContext } from "@/lib/with-rls";
import { store } from "@/lib/store";
import { getCompanyAutonomySettings, mergeAutonomySettings, AUTONOMY_MODES } from "@/lib/autonomy-settings";
import type { CompanyAutonomySettings } from "@/lib/types";

type Params = { params: Promise<{ id: string }> | { id: string } };

/** GET — current autonomy settings (viewer). */
export async function GET(_req: Request, context: Params) {
  const user = await getAuthUser();
  if (!user) return unauthorized();
  const { id: companyId } = await context.params;

  const check = await requireRoleForRequest(user.id, "viewer", { companyId });
  if (!check.ok) return forbidden();

  return withRlsContext(companyId, async () => {
    const company = await store.getCompany(companyId);
    if (!company) return NextResponse.json({ error: "company not found" }, { status: 404 });
    return NextResponse.json({ autonomy: getCompanyAutonomySettings(company) });
  });
}

/** PATCH — update autonomy settings (member). Validates mode + numeric bounds. */
export async function PATCH(request: Request, context: Params) {
  const user = await getAuthUser();
  if (!user) return unauthorized();
  const { id: companyId } = await context.params;

  const check = await requireRoleForRequest(user.id, "member", { companyId });
  if (!check.ok) return forbidden();

  const body = (await request.json().catch(() => ({}))) as Partial<CompanyAutonomySettings>;
  if (body.mode !== undefined && !AUTONOMY_MODES.includes(body.mode)) {
    return NextResponse.json({ error: `invalid mode; expected one of ${AUTONOMY_MODES.join(", ")}` }, { status: 400 });
  }
  for (const key of ["dailySpendLimitCents", "maxAutonomousToolCallsPerRun"] as const) {
    if (body[key] !== undefined && (typeof body[key] !== "number" || body[key]! < 0)) {
      return NextResponse.json({ error: `${key} must be a non-negative number` }, { status: 400 });
    }
  }

  return withRlsContext(companyId, async () => {
    const company = await store.getCompany(companyId);
    if (!company) return NextResponse.json({ error: "company not found" }, { status: 404 });

    const merged = mergeAutonomySettings(getCompanyAutonomySettings(company), body, user.id);
    await store.updateCompany(companyId, { brief: { ...company.brief, autonomy: merged } });
    return NextResponse.json({ autonomy: merged });
  });
}
