import { store } from "@/lib/store";
import type {
  Document,
  WorkbenchArtifact,
  WorkbenchAttempt,
  WorkbenchCheckpoint,
  WorkbenchEvent,
  WorkbenchSession,
} from "@/lib/types";
import { nowIso } from "@/lib/utils";

export function buildWorkbenchMemoryLog(input: {
  session: WorkbenchSession;
  events: WorkbenchEvent[];
  artifacts: WorkbenchArtifact[];
  attempts?: WorkbenchAttempt[];
  checkpoint?: WorkbenchCheckpoint;
  finalSummary?: string;
}): string {
  const { session, events, artifacts, attempts = [], checkpoint, finalSummary } = input;
  return [
    "# Workbench Memory Log",
    "",
    `- runId: ${session.id}`,
    `- companyId: ${session.companyId}`,
    `- objective: ${session.objective}`,
    `- agent: ${session.agentRole}`,
    `- mode: ${session.agentMode ?? "build"}`,
    `- status: ${session.status}`,
    `- provider: ${session.provider}`,
    `- workdir: ${checkpoint?.workdir ?? session.workdir ?? "unknown"}`,
    `- providerSessionId: ${checkpoint?.providerSessionId ?? "unknown"}`,
    `- previewUrl: ${checkpoint?.previewUrl ?? session.previewUrl ?? "none"}`,
    `- costCents: ${session.costCents}`,
    "",
    "## Attempts",
    attempts.length
      ? attempts.map((attempt) => [
          `### Attempt ${attempt.attemptNo}`,
          `- status: ${attempt.status}`,
          `- model: ${attempt.model}`,
          `- tokens: ${attempt.inputTokens} in / ${attempt.outputTokens} out`,
          `- costCents: ${attempt.costCents}`,
          attempt.feedback ? `- feedback: ${attempt.feedback}` : undefined,
        ].filter(Boolean).join("\n")).join("\n\n")
      : "No attempt rows recorded.",
    "",
    "## Events",
    events.length
      ? events.map((event) => formatEvent(event)).join("\n")
      : "No events recorded.",
    "",
    "## Artifacts",
    artifacts.length
      ? artifacts.map((artifact) => formatArtifact(artifact)).join("\n")
      : "No artifacts recorded.",
    "",
    "## Checkpoint",
    checkpoint ? [
      `- activePort: ${checkpoint.activePort ?? "none"}`,
      `- fileTreeHash: ${checkpoint.fileTreeHash ?? "none"}`,
      `- latestVerification: ${checkpoint.latestVerification ? JSON.stringify(checkpoint.latestVerification) : "none"}`,
      `- updatedAt: ${checkpoint.updatedAt}`,
    ].join("\n") : "No checkpoint recorded.",
    "",
    "## Final Summary",
    finalSummary?.trim() || "No final summary recorded.",
    "",
    `Generated: ${nowIso()}`,
  ].join("\n");
}

export async function persistWorkbenchMemoryLog(
  sessionId: string,
  options?: { finalSummary?: string },
): Promise<{ document: Document; artifact: WorkbenchArtifact; markdown: string }> {
  const session = await store.getWorkbenchSession(sessionId);
  if (!session) throw new Error(`Workbench session ${sessionId} not found`);

  const [events, artifacts, attempts, checkpoint] = await Promise.all([
    store.listWorkbenchEvents(session.id),
    store.listWorkbenchArtifacts(session.id),
    store.listWorkbenchAttempts(session.id).catch(() => []),
    store.getWorkbenchCheckpoint(session.id).catch(() => undefined),
  ]);
  const markdown = buildWorkbenchMemoryLog({
    session,
    events,
    artifacts,
    attempts,
    checkpoint,
    finalSummary: options?.finalSummary,
  });

  const document = await store.createDocument({
    companyId: session.companyId,
    type: "agent_note",
    title: `Workbench memory log: ${session.objective}`,
    content: markdown,
    source: `workbench:${session.id}`,
    memoryTier: "episodic",
  });

  const artifact = await store.addWorkbenchArtifact({
    companyId: session.companyId,
    sessionId: session.id,
    kind: "terminal_log",
    title: "Workbench memory log",
    storageKey: `workbench/${session.id}/memory-log.md`,
    mimeType: "text/markdown",
    sizeBytes: markdown.length,
    createdByAgent: session.agentRole,
    metadata: {
      documentId: document.id,
      memoryTier: document.memoryTier,
    },
  });

  return { document, artifact, markdown };
}

function formatEvent(event: WorkbenchEvent): string {
  return [
    `- [${event.seq}] ${event.type}/${event.status}: ${event.title}`,
    event.command ? `  - command: ${event.command}` : undefined,
    event.agentRole ? `  - agentRole: ${event.agentRole}` : undefined,
    event.attemptNo ? `  - attemptNo: ${event.attemptNo}` : undefined,
    event.durationMs ? `  - durationMs: ${event.durationMs}` : undefined,
    event.metadata ? `  - metadata: ${JSON.stringify(event.metadata)}` : undefined,
    event.content ? `  - detail: ${event.content.replace(/\s+/g, " ").slice(0, 600)}` : undefined,
  ].filter(Boolean).join("\n");
}

function formatArtifact(artifact: WorkbenchArtifact): string {
  return [
    `- ${artifact.id}: ${artifact.title}`,
    `  - kind: ${artifact.kind}`,
    `  - storageKey: ${artifact.storageKey}`,
    `  - mimeType: ${artifact.mimeType}`,
    `  - sizeBytes: ${artifact.sizeBytes}`,
    artifact.createdByAgent ? `  - createdByAgent: ${artifact.createdByAgent}` : undefined,
    artifact.sourceEventId ? `  - sourceEventId: ${artifact.sourceEventId}` : undefined,
    artifact.path ? `  - path: ${artifact.path}` : undefined,
    artifact.previewUrl ? `  - previewUrl: ${artifact.previewUrl}` : undefined,
    artifact.metadata ? `  - metadata: ${JSON.stringify(artifact.metadata)}` : undefined,
  ].filter(Boolean).join("\n");
}
