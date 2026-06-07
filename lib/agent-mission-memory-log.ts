import { store } from "@/lib/store";
import type { AgentMissionRun, AgentMissionStep, AgentMissionEvent, Approval, Artifact, Document } from "@/lib/types";
import { nowIso } from "@/lib/utils";

export function buildAgentMissionMemoryLog(input: {
  run: AgentMissionRun;
  steps: AgentMissionStep[];
  events: AgentMissionEvent[];
  approvals: Approval[];
  artifacts: Artifact[];
  finalSummary: string;
}): string {
  const { run, steps, events, approvals, artifacts, finalSummary } = input;
  return [
    "# Agent Mission Memory Log",
    "",
    `- runId: ${run.id}`,
    `- companyId: ${run.companyId}`,
    `- objective: ${run.objective}`,
    `- missionType: ${run.missionType}`,
    `- status: ${run.status}`,
    `- trigger: ${run.trigger}`,
    `- ownerSeat: ${run.ownerSeat}`,
    `- budgetCents: ${run.budgetCents}`,
    `- costCents: ${run.costCents}`,
    `- approvalPolicy: ${JSON.stringify(run.approvalPolicy)}`,
    `- modelPolicy: ${JSON.stringify(run.modelPolicy)}`,
    "",
    "## Seat Steps",
    steps.length ? steps.map(formatStep).join("\n") : "No steps recorded.",
    "",
    "## Events",
    events.length ? events.map(formatEvent).join("\n") : "No events recorded.",
    "",
    "## Approvals",
    approvals.length ? approvals.map(formatApproval).join("\n") : "No approvals requested.",
    "",
    "## Artifacts",
    artifacts.length ? artifacts.map(formatArtifact).join("\n") : "No artifacts recorded.",
    "",
    "## Final CEO Summary",
    finalSummary.trim() || "No final summary recorded.",
    "",
    `Generated: ${nowIso()}`,
  ].join("\n");
}

export async function persistAgentMissionMemoryLog(input: {
  run: AgentMissionRun;
  steps: AgentMissionStep[];
  approvals: Approval[];
  artifacts: Artifact[];
  finalSummary: string;
}): Promise<{ document: Document; artifact: Artifact; markdown: string }> {
  const events = await store.listAgentMissionEvents(input.run.id);
  const markdown = buildAgentMissionMemoryLog({ ...input, events });
  const document = await store.createDocument({
    companyId: input.run.companyId,
    type: "agent_note",
    title: `Agent mission memory log: ${input.run.objective}`,
    content: markdown,
    source: `agent-mission:${input.run.id}`,
    memoryTier: "episodic",
  });
  const artifact = await store.createArtifact({
    companyId: input.run.companyId,
    sourceDocumentId: document.id,
    type: "operating_memo",
    status: "ready",
    title: `Agent mission memory log: ${input.run.objective}`,
    summary: markdown.slice(0, 180),
    content: markdown,
    exportFormat: "markdown",
    storageKey: `agent-missions/${input.run.id}/memory-log.md`,
    createdByAgent: "ceo",
    provenance: {
      prompt: input.run.objective,
      sources: [input.run.id, document.id],
      model: "deterministic-agent-mission-runtime",
      tokens: 0,
      costCents: 0,
      generatedAt: nowIso(),
    },
  });
  return { document, artifact, markdown };
}

export async function refreshAgentMissionMemoryLog(
  run: AgentMissionRun,
): Promise<{ document: Document; artifact: Artifact; markdown: string } | undefined> {
  const storageKey = `agent-missions/${run.id}/memory-log.md`;
  const [steps, events, approvals, documents, artifacts] = await Promise.all([
    store.listAgentMissionSteps(run.id),
    store.listAgentMissionEvents(run.id),
    store.listApprovals(run.companyId),
    store.listDocuments(run.companyId),
    store.listArtifacts(run.companyId),
  ]);
  const missionApprovals = approvals.filter((approval) =>
    approval.toolName?.startsWith(`agent_mission:${run.id}:`)
  );
  const missionArtifacts = artifacts.filter((artifact) =>
    artifact.storageKey?.startsWith(`agent-missions/${run.id}/`)
    && artifact.storageKey !== storageKey
  );
  const markdown = buildAgentMissionMemoryLog({
    run,
    steps,
    events,
    approvals: missionApprovals,
    artifacts: missionArtifacts,
    finalSummary: run.finalSummary ?? "",
  });
  const title = `Agent mission memory log: ${run.objective}`;
  const existingDocument = documents.find((doc) => doc.source === `agent-mission:${run.id}`);
  const document = existingDocument
    ? await store.updateDocument(existingDocument.id, { title, content: markdown }) ?? existingDocument
    : await store.createDocument({
      companyId: run.companyId,
      type: "agent_note",
      title,
      content: markdown,
      source: `agent-mission:${run.id}`,
      memoryTier: "episodic",
    });

  const existingArtifact = artifacts.find((artifact) => artifact.storageKey === storageKey);
  const artifactPatch = {
    companyId: run.companyId,
    sourceDocumentId: document.id,
    type: "operating_memo" as const,
    status: "ready" as const,
    title,
    summary: markdown.slice(0, 180),
    content: markdown,
    exportFormat: "markdown" as const,
    storageKey,
    createdByAgent: "ceo" as const,
    provenance: {
      prompt: run.objective,
      sources: [run.id, document.id],
      model: "deterministic-agent-mission-runtime",
      tokens: 0,
      costCents: 0,
      generatedAt: nowIso(),
    },
  };
  const artifact = existingArtifact
    ? await store.updateArtifact(existingArtifact.id, artifactPatch) ?? existingArtifact
    : await store.createArtifact(artifactPatch);
  return { document, artifact, markdown };
}

function formatStep(step: AgentMissionStep): string {
  return [
    `- [${step.seq}] ${step.agentRole}: ${step.title}`,
    `  - status: ${step.status}`,
    `  - expectedOutput: ${step.expectedOutput}`,
    step.output ? `  - output: ${step.output.replace(/\s+/g, " ").slice(0, 600)}` : undefined,
    step.approvalId ? `  - approvalId: ${step.approvalId}` : undefined,
    `  - costCents: ${step.costCents}`,
  ].filter(Boolean).join("\n");
}

function formatEvent(event: AgentMissionEvent): string {
  return [
    `- [${event.seq}] ${event.kind}`,
    event.stepId ? `  - stepId: ${event.stepId}` : undefined,
    `  - payload: ${JSON.stringify(event.payload)}`,
  ].filter(Boolean).join("\n");
}

function formatApproval(approval: Approval): string {
  return [
    `- ${approval.id}: ${approval.action}`,
    `  - status: ${approval.status}`,
    `  - reason: ${approval.reason}`,
    approval.previewContent ? `  - preview: ${approval.previewContent.replace(/\s+/g, " ").slice(0, 400)}` : undefined,
  ].filter(Boolean).join("\n");
}

function formatArtifact(artifact: Artifact): string {
  return [
    `- ${artifact.id}: ${artifact.title}`,
    `  - type: ${artifact.type}`,
    `  - status: ${artifact.status}`,
    `  - createdByAgent: ${artifact.createdByAgent}`,
    artifact.storageKey ? `  - storageKey: ${artifact.storageKey}` : undefined,
  ].filter(Boolean).join("\n");
}
