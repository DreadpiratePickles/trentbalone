import { NextResponse } from "next/server";
import { forbidden, getAuthUser, requireRoleForRequest, unauthorized } from "@/lib/session";
import { withRlsContext } from "@/lib/with-rls";
import { loadAgentOpsPayload } from "@/lib/agent-ops-loader";

type Params = { params: Promise<{ id: string }> | { id: string } };

/**
 * GET /api/companies/[id]/ops[?runId=...]
 *
 * Read-only Agent Operations Control Tower payload: recent durable runs, plus the
 * full evidence ledger / trust summary / approvals / memory-compounding /
 * diagnostics for the selected (or most recent) run. Company-scoped under RLS.
 */
export async function GET(request: Request, context: Params) {
  const user = await getAuthUser();
  if (!user) return unauthorized();
  const { id: companyId } = await context.params;

  const check = await requireRoleForRequest(user.id, "viewer", { companyId });
  if (!check.ok) return forbidden();

  const runId = new URL(request.url).searchParams.get("runId") ?? undefined;

  return withRlsContext(companyId, async () => {
    const payload = await loadAgentOpsPayload(companyId, { runId });
    return NextResponse.json(payload);
  });
}
