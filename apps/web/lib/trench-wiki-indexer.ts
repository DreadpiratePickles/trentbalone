import { store } from "@/lib/store";
import { buildTrenchWikiIndex, type WikiIndex } from "@/lib/trench-wiki";
import type { Document, WorkbenchSession } from "@/lib/types";

export async function runWikiIndexRefresh(input: {
  companyId: string;
  sessionId?: string;
  generatedAt?: string;
}): Promise<{ index: WikiIndex; document: Document }> {
  const company = await store.getCompany(input.companyId);
  if (!company) throw new Error(`Company ${input.companyId} not found`);

  const scopedSession = input.sessionId ? await store.getWorkbenchSession(input.sessionId) : undefined;
  const scopedSessions: WorkbenchSession[] = input.sessionId
    ? (scopedSession ? [scopedSession] : [])
    : await store.listWorkbenchSessions(input.companyId);

  const [documents, usage, eventGroups, artifactGroups] = await Promise.all([
    store.listDocuments(input.companyId),
    store.listUsage(input.companyId),
    Promise.all(scopedSessions.map((session) => store.listWorkbenchEvents(session.id))),
    Promise.all(scopedSessions.map((session) => store.listWorkbenchArtifacts(session.id))),
  ]);

  const index = buildTrenchWikiIndex({
    companyId: input.companyId,
    sessions: scopedSessions,
    events: eventGroups.flat(),
    artifacts: artifactGroups.flat(),
    documents,
    usage,
    budgetCents: company.budgetCents,
    generatedAt: input.generatedAt,
  });

  const document = await store.createDocument({
    companyId: input.companyId,
    type: "research",
    title: "Trench Wiki Index",
    content: JSON.stringify(index, null, 2),
    source: "trench_wiki_indexer",
    memoryTier: "semantic",
    validFrom: index.generatedAt,
  });

  return { index, document };
}
