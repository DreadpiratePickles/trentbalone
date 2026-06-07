import type { WorkbenchArtifact, WorkbenchEvent, WorkbenchSession } from "@/lib/types";

export function shouldShowWorkbenchTestMode(session: Pick<WorkbenchSession, "status"> | null | undefined): boolean {
  return session?.status === "completed";
}

export function summarizeWorkbenchCompletion(
  events: Pick<WorkbenchEvent, "type" | "status">[],
  artifacts: Pick<WorkbenchArtifact, "kind">[],
) {
  return {
    completedEvents: events.filter((event) => event.status === "completed").length,
    fileEvents: events.filter((event) => event.type === "file").length,
    testEvents: events.filter((event) => event.type === "test").length,
    artifactCount: artifacts.length,
    previewCount: artifacts.filter((artifact) => artifact.kind === "preview").length,
    screenshotCount: artifacts.filter((artifact) => artifact.kind === "screenshot").length,
  };
}
