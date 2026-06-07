import { NextResponse } from "next/server";
import { checkRateLimit, rateLimitExceeded } from "@/lib/rate-limit";
import { buildControlPlaneDescriptor, normalizeModelTierByRole, validateControlPlanePatch } from "@/lib/control-plane-settings";
import { forbidden, getAuthUser, requireRoleForRequest, unauthorized } from "@/lib/session";
import { store } from "@/lib/store";
import { withRlsContext } from "@/lib/with-rls";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();
  const { id: companyId } = await params;
  const role = await requireRoleForRequest(user.id, "viewer", { companyId });
  if (!role.ok) return forbidden();
  const limit = await checkRateLimit(user.id, companyId);
  if (!limit.ok) return rateLimitExceeded(limit.retryAfterSeconds);

  return withRlsContext(companyId, async () => {
    const company = await store.getCompany(companyId);
    if (!company) return NextResponse.json({ error: "company not found" }, { status: 404 });
    return NextResponse.json({ controlPlane: buildControlPlaneDescriptor(companyId) });
  });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();
  const { id: companyId } = await params;
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const validation = validateControlPlanePatch(body);
  if (!validation.ok) return NextResponse.json({ error: validation.error }, { status: 400 });

  const role = await requireRoleForRequest(user.id, "member", { companyId });
  if (!role.ok) return forbidden();
  const limit = await checkRateLimit(user.id, companyId);
  if (!limit.ok) return rateLimitExceeded(limit.retryAfterSeconds);

  return withRlsContext(companyId, async () => {
    const company = await store.getCompany(companyId);
    if (!company) return NextResponse.json({ error: "company not found" }, { status: 404 });

    if (body.section === "models") {
      await store.updateCompany(companyId, {
        brief: {
          ...company.brief,
          modelTierByRole: normalizeModelTierByRole(body.modelTierByRole),
        },
      });
    }

    await store.addAudit(
      companyId,
      "user",
      "control_plane.update",
      "settings",
      companyId,
      `Updated ${String(body.section)} control-plane settings`
    );

    return NextResponse.json({ controlPlane: buildControlPlaneDescriptor(companyId) });
  });
}
