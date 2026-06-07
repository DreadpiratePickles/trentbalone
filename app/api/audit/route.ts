import { NextResponse } from "next/server";
import { store } from "@/lib/store";
import { canAccessCompany, forbidden, getAuthUser, getUserCompanyIds, requireRole, unauthorized } from "@/lib/session";

export async function GET(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const companyId = new URL(request.url).searchParams.get("companyId") ?? undefined;
  if (companyId) {
    if (!(await canAccessCompany(user.id, companyId))) return forbidden();
    const check = await requireRole(user.id, companyId, "member");
    if (!check.ok) return forbidden();
  }

  const companyIds = companyId ? [companyId] : await getUserCompanyIds(user.id);
  const auditLogs = companyIds
    ? (await Promise.all(companyIds.map((id) => store.listAuditLogs(id)))).flat()
    : await store.listAuditLogs();

  return NextResponse.json({ auditLogs });
}
