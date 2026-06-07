import { NextResponse } from "next/server";
import { store } from "@/lib/store";
import { getAuthUser, unauthorized, forbidden, requireRoleForRequest } from "@/lib/session";
import { withRlsContext } from "@/lib/with-rls";
import { getUnbilledUsage } from "@/lib/payments/usage-meter";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const company = await store.getCompany(id);
  if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });

  const check = await requireRoleForRequest(user.id, "viewer", { companyId: company.id });
  if (!check.ok) return forbidden();

  const now = new Date();
  const defaultPeriod = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const url = new URL(request.url);
  const billingPeriod = url.searchParams.get("billingPeriod") ?? defaultPeriod;

  return withRlsContext(company.id, async () => {
    const { totalCents, items } = await getUnbilledUsage(company.id, billingPeriod);
    return NextResponse.json({ billingPeriod, totalCents, items });
  });
}
