import { store } from "@/lib/store";
import { nowIso } from "@/lib/utils";
import { buildContentMissionActionLedger } from "@/lib/content-mission";
import type { OrchestrationPlan, StepRecord } from "@/lib/orchestrator-runtime";
import type { Artifact, ContentMissionAction, ContentMissionRun, Document } from "@/lib/types";

export function buildContentMissionMemoryLog(input: {
  run: ContentMissionRun;
  actions: ContentMissionAction[];
  finalSummary?: string;
}): string {
  const { run, actions, finalSummary } = input;
  return [
    "# Content Mission Memory Log",
    "",
    `- runId: ${run.id}`,
    `- companyId: ${run.companyId}`,
    `- objective: ${run.objective}`,
    `- operatingMode: ${run.operatingMode}`,
    `- status: ${run.status}`,
    `- externalActionStatus: ${run.externalActionStatus}`,
    `- ownerSeat: ${run.ownerSeat}`,
    `- socialPublishingRequested: ${run.socialPublishingRequested}`,
    `- paidAdsRequested: ${run.paidAdsRequested}`,
    `- requiredSocialPlatforms: ${run.requiredSocialPlatforms.join(", ") || "none"}`,
    `- requiredMarketingPlatforms: ${run.requiredMarketingPlatforms.join(", ") || "none"}`,
    `- budgetCents: ${run.budgetCents}`,
    `- costCents: ${run.costCents}`,
    "",
    "## Approval Gates",
    ...(run.approvalGates.length ? run.approvalGates.map((gate) => `- ${gate}`) : ["- none"]),
    "",
    "## External Action Ledger",
    ...(actions.length
      ? actions.map((action) =>
          [
            `- ${action.kind} — ${action.status}`,
            `owner=${action.owner}`,
            `gate=${action.approvalGate}`,
            action.relatedPlatforms.length ? `platforms=${action.relatedPlatforms.join(",")}` : "",
            `reason=${action.reason}`,
          ]
            .filter(Boolean)
            .join(" — "),
        )
      : ["- none"]),
    "",
    "## Memory Fields",
    ...(run.memoryLogFields.length ? run.memoryLogFields.map((field) => `- ${field}`) : ["- none"]),
    "",
    "## Final Summary",
    finalSummary?.trim() || run.summary?.trim() || "No final summary recorded.",
    "",
    `Generated: ${nowIso()}`,
  ].join("\n");
}

export async function persistContentMissionMemoryLog(
  runId: string,
  options: { plan: OrchestrationPlan; steps: StepRecord[]; finalSummary?: string },
): Promise<{ run: ContentMissionRun; document: Document | undefined; artifact: Artifact; markdown: string } | null> {
  const run = await store.getContentMissionRun(runId);
  if (!run) return null;

  const persisted = await store.listContentMissionActions(runId);
  const actions = persisted.length
    ? persisted
    : buildContentMissionActionLedger(options.plan, options.steps).map((item) => ({
        id: `${runId}:${item.id}`,
        runId,
        companyId: run.companyId,
        ledgerItemId: item.id,
        kind: item.kind,
        owner: item.owner,
        status: item.status,
        approvalGate: item.approvalGate,
        sourceStage: item.sourceStage,
        reason: item.reason,
        relatedPlatforms: item.relatedPlatforms,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      }));

  const markdown = buildContentMissionMemoryLog({
    run,
    actions,
    finalSummary: options.finalSummary,
  });

  const document = await store
    .createDocument({
      companyId: run.companyId,
      type: "agent_note",
      title: `Content mission memory log · ${run.objective.slice(0, 60)}`,
      content: markdown,
      source: `content-mission:${run.id}:memory-log.md`,
      version: 1,
      memoryTier: "episodic",
      validFrom: run.completedAt ?? nowIso(),
    })
    .catch(() => undefined);

  const artifact = await store.createArtifact({
    companyId: run.companyId,
    sourceCycleId: run.cycleId ?? run.id,
    sourceDocumentId: document?.id,
    type: "operating_memo",
    status: "ready",
    title: `Content mission memory log · ${run.objective.slice(0, 60)}`,
    summary: `Content mission memory log for ${run.objective}`,
    content: markdown,
    exportFormat: "markdown",
    storageKey: `content-mission/${run.id}/memory-log.md`,
    createdByAgent: run.ownerSeat,
    provenance: {
      prompt: run.objective,
      sources: [`content-mission:${run.id}`, ...actions.map((action) => `action:${action.ledgerItemId}:${action.kind}`)],
      model: "content-mission-runtime",
      tokens: 0,
      costCents: run.costCents,
      generatedAt: run.completedAt ?? nowIso(),
    },
  });

  await store.updateContentMissionRun(run.id, { memoryLogArtifactId: artifact.id });

  return { run, document, artifact, markdown };
}
