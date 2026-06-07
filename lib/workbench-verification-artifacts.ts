import { store } from "@/lib/store";
import type { WorkbenchSession } from "@/lib/types";
import type { VerifyVerdict } from "@/lib/workbench-verify";

export async function persistWorkbenchFileArtifact(input: {
  session: WorkbenchSession;
  path: string;
  content: string;
  sourceEventId?: string;
  attemptNo?: number;
}): Promise<string | undefined> {
  const { session, path, content, sourceEventId, attemptNo } = input;
  const artifact = await store.addWorkbenchArtifact({
    companyId: session.companyId,
    sessionId: session.id,
    kind: "file",
    title: `File: ${path}`,
    storageKey: `workbench/${session.id}/files/${path}`,
    mimeType: mimeTypeForPath(path),
    sizeBytes: Buffer.byteLength(content, "utf8"),
    createdByAgent: session.agentRole,
    sourceEventId,
    path,
    metadata: {
      attemptNo,
      bytes: content.length,
    },
  });
  return artifact.id;
}

export async function persistVerificationScreenshotArtifact(input: {
  session: WorkbenchSession;
  verdict: VerifyVerdict;
  attemptNo: number;
}): Promise<string | undefined> {
  const { session, verdict, attemptNo } = input;
  const screenshot = verdict.screenshot;
  if (!screenshot?.storageKey) return undefined;

  const existing = (await store.listWorkbenchArtifacts(session.id).catch(() => []))
    .find((artifact) => artifact.kind === "screenshot" && artifact.storageKey === screenshot.storageKey);
  if (existing) return existing.id;

  const previewUrl = verdict.previewUrl;
  const artifact = await store.addWorkbenchArtifact({
    companyId: session.companyId,
    sessionId: session.id,
    kind: "screenshot",
    title: previewUrl ? `Verification screenshot: ${previewUrl}` : "Verification screenshot",
    storageKey: screenshot.storageKey,
    mimeType: screenshot.dataUri.startsWith("data:image/svg+xml") ? "image/svg+xml" : "image/png",
    sizeBytes: screenshot.dataUri.length,
    createdByAgent: session.agentRole,
    previewUrl,
    metadata: {
      width: screenshot.width,
      height: screenshot.height,
      attemptNo,
      verificationPassed: verdict.passed,
      realScreenshot: screenshot.dataUri.startsWith("data:image/png"),
    },
  });

  await store.addWorkbenchEvent({
    companyId: session.companyId,
    sessionId: session.id,
    type: "screenshot",
    status: "completed",
    title: "Verification screenshot captured",
    content: previewUrl ?? screenshot.storageKey,
    artifactId: artifact.id,
    attemptNo,
    agentRole: session.agentRole,
    metadata: { verificationPassed: verdict.passed },
  });

  return artifact.id;
}

function mimeTypeForPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".html")) return "text/html";
  if (lower.endsWith(".css")) return "text/css";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".md")) return "text/markdown";
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "text/typescript";
  if (lower.endsWith(".js") || lower.endsWith(".jsx")) return "text/javascript";
  return "text/plain";
}
