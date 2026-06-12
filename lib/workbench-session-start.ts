import { checkoutRepository } from "@/lib/git-checkout";
import { store } from "@/lib/store";
import type { WorkbenchSession } from "@/lib/types";
import { nowIso } from "@/lib/utils";
import { getWorkbenchProvider } from "@/lib/workbench-provider";
import { enqueueWorkbenchSession, ensureWorkbenchSandboxReady } from "@/lib/workbench-orchestrator";
import "@/lib/workbench-providers";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

export async function startWorkbenchSessionAfterImports(sessionId: string): Promise<WorkbenchSession> {
  const session = await store.getWorkbenchSession(sessionId);
  if (!session) throw new Error(`Workbench session ${sessionId} not found`);
  if (TERMINAL_STATUSES.has(session.status)) {
    throw new Error(`Cannot start terminal workbench session ${sessionId}`);
  }

  try {
    await prepareWorkbenchSessionWorkspace(session);
    await enqueueWorkbenchSession(session.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await store.updateWorkbenchSession(session.id, {
      status: "failed",
      stoppedAt: nowIso(),
    });
    await store.addWorkbenchEvent({
      companyId: session.companyId,
      sessionId: session.id,
      type: "system",
      status: "failed",
      title: "Workbench import/start failed",
      content: message,
      metadata: {
        schemaVersion: "workbench.event.v1",
        action: "import_start_failed",
        provider: session.provider,
        repoUrl: session.repoUrl,
      },
    });
    throw err;
  }

  const refreshed = await store.getWorkbenchSession(session.id);
  if (!refreshed) throw new Error(`Workbench session ${session.id} not found after start`);
  return refreshed;
}

export async function prepareWorkbenchSessionWorkspace(session: WorkbenchSession): Promise<void> {
  await ensureWorkbenchSandboxReady(session);

  if (!session.repoUrl) return;

  const provider = getWorkbenchProvider(session.provider);
  await store.addWorkbenchEvent({
    companyId: session.companyId,
    sessionId: session.id,
    type: "system",
    status: "running",
    title: "GitHub import started",
    content: `Cloning ${session.repoUrl} into the Workbench workspace before the agent starts.`,
    metadata: {
      schemaVersion: "workbench.event.v1",
      action: "repo_import_start",
      repoUrl: session.repoUrl,
    },
  });

  await checkoutRepository(session, provider);

  await store.addWorkbenchEvent({
    companyId: session.companyId,
    sessionId: session.id,
    type: "system",
    status: "completed",
    title: "GitHub import completed",
    content: `${session.repoUrl} is available in the Workbench workspace.`,
    metadata: {
      schemaVersion: "workbench.event.v1",
      action: "repo_import_complete",
      repoUrl: session.repoUrl,
    },
  });
}
