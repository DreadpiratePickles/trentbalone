import { store } from "@/lib/store";
import { forbidden, getAuthUser, requireRole, unauthorized } from "@/lib/session";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id: companyId } = await params;
  const check = await requireRole(user.id, companyId, "admin");
  if (!check.ok) return forbidden();

  const logs = await store.listAuditLogs(companyId);
  // Export oldest-first for cold storage
  const sorted = [...logs].reverse();
  const ndjson = sorted.map((l) => JSON.stringify(l)).join("\n");

  return new Response(ndjson, {
    status: 200,
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "content-disposition": `attachment; filename="audit-${companyId}-${new Date().toISOString().slice(0, 10)}.ndjson"`,
    },
  });
}
