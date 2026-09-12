import { NextResponse } from "next/server";
import { checkRateLimit, rateLimitExceeded } from "@/lib/rate-limit";
import { forbidden, getAuthUser, requireRoleForRequest, unauthorized } from "@/lib/session";
import { store } from "@/lib/store";
import { buildTrenchWikiIndex } from "@/lib/trench-wiki";
import type { WorkbenchSession } from "@/lib/types";
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

    const sessions: WorkbenchSession[] = await store.listWorkbenchSessions(companyId);
    const [documents, usage, eventGroups, artifactGroups] = await Promise.all([
      store.listDocuments(companyId),
      store.listUsage(companyId),
      Promise.all(sessions.map((session) => store.listWorkbenchEvents(session.id))),
      Promise.all(sessions.map((session) => store.listWorkbenchArtifacts(session.id))),
    ]);

    const wiki = buildTrenchWikiIndex({
      companyId,
      sessions,
      events: eventGroups.flat(),
      artifacts: artifactGroups.flat(),
      documents,
      usage,
      budgetCents: company.budgetCents,
    });

    return NextResponse.json({ wiki });
  });
}
