import { NextResponse } from "next/server";
import { checkRateLimit, rateLimitExceeded } from "@/lib/rate-limit";
import { forbidden, getAuthUser, requireRoleForRequest, unauthorized } from "@/lib/session";
import { store } from "@/lib/store";
import { buildTrenchWikiIndex } from "@/lib/trench-wiki";
import { buildGroundedAnswer, buildSearchCorpus, buildSearchUsageAnalytics, retrieveGroundedResults, type SearchTurn } from "@/lib/trench-search";
import type { WorkbenchSession } from "@/lib/types";
import { withRlsContext } from "@/lib/with-rls";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id: companyId } = await params;
  const body = await request.json().catch(() => ({})) as { query?: string; followUps?: SearchTurn[]; apiKeyId?: string };
  const query = body.query?.trim() ?? "";
  if (!query) return NextResponse.json({ error: "query required" }, { status: 400 });

  const role = await requireRoleForRequest(user.id, "viewer", { companyId });
  if (!role.ok) return forbidden();

  const limit = await checkRateLimit(user.id, companyId);
  if (!limit.ok) return rateLimitExceeded(limit.retryAfterSeconds);

  return withRlsContext(companyId, async () => {
    const company = await store.getCompany(companyId);
    if (!company) return NextResponse.json({ error: "company not found" }, { status: 404 });

    const sessions: WorkbenchSession[] = await store.listWorkbenchSessions(companyId);
    const [documents, usage, memoryResults, eventGroups, artifactGroups] = await Promise.all([
      store.listDocuments(companyId),
      store.listUsage(companyId),
      store.searchMemory(companyId, query),
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
    const corpus = buildSearchCorpus(wiki, memoryResults);
    const results = retrieveGroundedResults(query, corpus, 5);
    const answer = buildGroundedAnswer(query, results, body.followUps ?? []);
    const analytics = buildSearchUsageAnalytics({
      companyId,
      apiKeyId: body.apiKeyId,
      query,
      resultCount: results.length,
      citationCount: answer.citations.length,
    });

    return NextResponse.json({ answer, results, analytics });
  });
}
