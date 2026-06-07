import { store } from "@/lib/store";
import { forbidden, getAuthUser, requireRole, unauthorized } from "@/lib/session";
import { verifyAuditChain } from "@/lib/audit-log";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id: companyId } = await params;
  const check = await requireRole(user.id, companyId, "admin");
  if (!check.ok) return forbidden();

  const result = await verifyAuditChain(companyId);

  return Response.json(result, { status: 200 });
}
