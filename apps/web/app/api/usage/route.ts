import { NextResponse } from "next/server";
import { getSpendSummary } from "@/lib/spend";
import { store } from "@/lib/store";
import { forbidden, getAuthUser, requireRoleForRequest, unauthorized } from "@/lib/session";

export async function GET(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const companyId = new URL(request.url).searchParams.get("companyId");
  if (!companyId) {
    return NextResponse.json({ error: "companyId is required" }, { status: 400 });
  }

  const check = await requireRoleForRequest(user.id, "viewer", { companyId });
  if (!check.ok) return forbidden();

  const usage = await store.listUsage(companyId);
  const totalCents = usage.reduce((sum, entry) => sum + entry.amountCents, 0);
  const spendSummary = await getSpendSummary(companyId);
  return NextResponse.json({ usage, totalCents, spendSummary });
}
