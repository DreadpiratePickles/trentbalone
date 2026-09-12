import { NextRequest, NextResponse } from "next/server";
import { forbidden, getAuthUser, requireRoleForRequest, unauthorized } from "@/lib/session";
import { runCompanyHeartbeat } from "@/lib/heartbeat";
import { store } from "@/lib/store";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getAuthUser();
  if (!user) return unauthorized();
  const { id: companyId } = await params;

  const check = await requireRoleForRequest(user.id, "member", { companyId });
  if (!check.ok) return forbidden();

  const company = await store.getCompany(companyId);
  if (!company) return NextResponse.json({ error: "company not found" }, { status: 404 });

  const report = await runCompanyHeartbeat(company);
  return NextResponse.json({ report });
}
