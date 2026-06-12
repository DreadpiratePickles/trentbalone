import * as os from "os";
import * as path from "path";
import { store } from "@/lib/store";
import type { WorkbenchCheckpoint, WorkbenchSession } from "@/lib/types";
import { nowIso } from "@/lib/utils";
import { getWorkbenchProvider, type WorkbenchSandboxHandle } from "@/lib/workbench-provider";
import "@/lib/workbench-providers";
import { reapAllOrphanedPreviews } from "@/lib/workbench-preview-reaper";

// Mirror of WORKBENCH_STORAGE_ROOT in workbench-local-provider.ts. Kept local so
// the sweep doesn't pull the provider (and its spawn machinery) into this module.
const WORKBENCH_SESSIONS_ROOT = path.join(
  process.env.WORKBENCH_STORAGE_ROOT ?? path.join(os.tmpdir(), "trent-workbench"),
  "sessions"
);

export type TerminationReason =
  | "completed"
  | "cancelled"
  | "timeout"
  | "budget"
  | "idle"
  | "error";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const IDLE_TIMEOUT_SECONDS = Number(
  process.env.WORKBENCH_IDLE_TIMEOUT_SECONDS ?? 600
);
const APP_SOLO_HEARTBEAT_STALE_SECONDS = Number(
  process.env.APP_SOLO_HEARTBEAT_STALE_SECONDS ?? 120
);
const STUCK_STARTING_SECONDS = 120;

function finalStatus(reason: TerminationReason): "completed" | "failed" | "cancelled" {
  if (reason === "completed" || reason === "idle") return "completed";
  if (reason === "cancelled") return "cancelled";
  return "failed";
}

function checkpointPreviewMode(checkpoint: WorkbenchCheckpoint): WorkbenchSandboxHandle["previewMode"] {
  if (checkpoint.provider === "mock_local" || checkpoint.activePort) return "local_port";
  if (checkpoint.previewUrl) return "provider_url";
  return "none";
}

function checkpointToHandle(checkpoint: WorkbenchCheckpoint): WorkbenchSandboxHandle {
  return {
    provider: checkpoint.provider,
    providerSessionId: checkpoint.providerSessionId,
    workdir: checkpoint.workdir,
    previewMode: checkpointPreviewMode(checkpoint),
    providerUrl: checkpoint.previewUrl,
    expiresAt: checkpoint.sandboxExpiresAt,
  };
}

async function persistSandboxHandle(
  checkpoint: WorkbenchCheckpoint | undefined,
  handle: WorkbenchSandboxHandle,
  session: { companyId: string; id: string; provider: WorkbenchCheckpoint["provider"] }
): Promise<void> {
  await store.upsertWorkbenchCheckpoint({
    companyId: session.companyId,
    sessionId: session.id,
    provider: handle.provider ?? session.provider,
    providerSessionId: handle.providerSessionId,
    workdir: handle.workdir,
    previewUrl: handle.providerUrl,
    activePort: checkpoint?.activePort,
    fileTreeHash: checkpoint?.fileTreeHash,
    latestVerification: checkpoint?.latestVerification,
    sandboxExpiresAt: handle.expiresAt,
  }).catch(() => {});
}

export async function stopWorkbenchSession(
  sessionId: string,
  reason: TerminationReason
): Promise<void> {
  const session = await store.getWorkbenchSession(sessionId);
  if (!session) return;
  if (TERMINAL_STATUSES.has(session.status)) return;

  try {
    const provider = getWorkbenchProvider(session.provider);
    await provider.stop(session);
  } catch (err) {
    console.error(`[Orchestrator] provider.stop failed for ${sessionId}:`, err);
  }

  await store.updateWorkbenchSession(sessionId, {
    status: finalStatus(reason),
    stoppedAt: nowIso()
  });

  await store.addWorkbenchEvent({
    companyId: session.companyId,
    sessionId,
    type: "system",
    status: "completed",
    title: "Session terminated",
    content: `Session stopped: ${reason}.`
  });
}

export async function workbenchSessionSweep(options?: {
  nowMs?: number;
}): Promise<{ terminated: number; paused: number }> {
  const now = options?.nowMs ?? Date.now();

  // Reap orphaned background preview processes left behind by a server/container
  // restart (the in-memory tracking map in workbench-local-provider is cleared on
  // restart, but the detached `npm run dev` / node preview keeps holding its port).
  // Best-effort: must never break the session sweep.
  await reapAllOrphanedPreviews(WORKBENCH_SESSIONS_ROOT).catch(() => 0);

  const sessions = await store.listWorkbenchSessions();
  let terminated = 0;
  let paused = 0;

  for (const session of sessions) {
    if (TERMINAL_STATUSES.has(session.status)) continue;

    // Use startedAt if available, fall back to createdAt (always set) so stuck-starting
    // sessions without an explicit startedAt are still reaped.
    const startedMs = new Date(session.startedAt ?? session.createdAt).getTime();
    const updatedMs = new Date(session.updatedAt).getTime();
    const elapsedSeconds = (now - startedMs) / 1000;
    const idleSeconds = (now - updatedMs) / 1000;

    if (session.status === "starting" || session.status === "queued") {
      if (elapsedSeconds > STUCK_STARTING_SECONDS) {
        await stopWorkbenchSession(session.id, "error");
        terminated++;
      }
      continue;
    }

    if (session.status !== "running") continue;

    if (elapsedSeconds > session.metadata.maxRuntimeSeconds) {
      await stopWorkbenchSession(session.id, "timeout");
      terminated++;
      continue;
    }

    if (session.costCents >= session.metadata.maxCostCents) {
      await stopWorkbenchSession(session.id, "budget");
      terminated++;
      continue;
    }

    if (await pauseStaleAppSoloSession(session, now)) {
      paused++;
      continue;
    }

    if (idleSeconds > IDLE_TIMEOUT_SECONDS) {
      await stopWorkbenchSession(session.id, "idle");
      terminated++;
    }
  }

  return { terminated, paused };
}

/**
 * Ensure an E2B/Daytona sandbox is alive and in the in-process sandboxes Map.
 * Called before runWorkbenchAgent so that a container restart (which clears the
 * in-memory Map) doesn't cause "No E2B sandbox for session X" errors.
 *
 * - If the sandbox is already in memory (same process, no restart), this is a
 *   cheap no-op (provider.start() guards with sandboxes.get(session.id)).
 * - If the process restarted, we restore via the persisted providerSessionId.
 * - If no checkpoint exists we start fresh.
 */
export async function ensureWorkbenchSandboxReady(
  session: { id: string; companyId: string; provider: WorkbenchCheckpoint["provider"] }
): Promise<void> {
  const provider = getWorkbenchProvider(session.provider);
  const checkpoint = await store.getWorkbenchCheckpoint(session.id).catch(() => undefined);
  try {
    const handle = checkpoint?.providerSessionId && provider.restore
      ? await provider.restore(session as Parameters<typeof provider.restore>[0], checkpointToHandle(checkpoint))
      : await provider.start(session as Parameters<typeof provider.start>[0]);
    if (handle) {
      await persistSandboxHandle(checkpoint, handle, session);
    }
  } catch (err) {
    // Log but don't throw — let runWorkbenchAgent surface a cleaner error.
    console.error(`[Orchestrator] ensureWorkbenchSandboxReady failed for ${session.id}:`, err);
    throw err;
  }
}

export async function recordAppSoloHeartbeat(
  sessionId: string,
  options?: { nowIso?: string }
): Promise<WorkbenchSession | undefined> {
  const session = await store.getWorkbenchSession(sessionId);
  if (!session) return undefined;
  const appSolo = requireAppSoloMetadata(session);
  const timestamp = options?.nowIso ?? nowIso();
  return store.updateWorkbenchSession(sessionId, {
    metadata: {
      ...session.metadata,
      appSolo: {
        ...appSolo,
        lastHeartbeatAt: timestamp,
        lastLifecycleEvent: "heartbeat",
      },
    },
  });
}

export async function resumeAppSoloWorkbenchSession(
  sessionId: string,
  options?: {
    nowIso?: string;
    ensureReady?: typeof ensureWorkbenchSandboxReady;
  }
): Promise<WorkbenchSession> {
  const session = await store.getWorkbenchSession(sessionId);
  if (!session) throw new Error(`Workbench session ${sessionId} not found`);
  if (TERMINAL_STATUSES.has(session.status)) {
    throw new Error(`Cannot resume terminal workbench session ${sessionId}`);
  }
  const appSolo = requireAppSoloMetadata(session);
  const timestamp = options?.nowIso ?? nowIso();
  const ensureReady = options?.ensureReady ?? ensureWorkbenchSandboxReady;

  await ensureReady(session);

  const updated = await store.updateWorkbenchSession(sessionId, {
    status: "running",
    startedAt: session.startedAt ?? timestamp,
    metadata: {
      ...session.metadata,
      appSolo: {
        ...appSolo,
        lastHeartbeatAt: timestamp,
        lastLifecycleEvent: "resume",
        resumeCount: (appSolo.resumeCount ?? 0) + 1,
      },
    },
  });
  if (!updated) throw new Error(`Workbench session ${sessionId} not found`);

  await store.addWorkbenchEvent({
    companyId: updated.companyId,
    sessionId: updated.id,
    type: "system",
    status: "completed",
    title: "App Solo session resumed",
    content: "App Solo session heartbeat and sandbox state were restored.",
    metadata: {
      schemaVersion: "workbench.event.v1",
      action: "resume",
      resumedAt: timestamp,
    },
  });

  return updated;
}

async function pauseStaleAppSoloSession(
  session: WorkbenchSession,
  nowMs: number
): Promise<boolean> {
  const appSolo = session.metadata.appSolo;
  if (!appSolo) return false;
  const lastHeartbeatMs = appSolo.lastHeartbeatAt
    ? Date.parse(appSolo.lastHeartbeatAt)
    : Date.parse(session.updatedAt);
  if (!Number.isFinite(lastHeartbeatMs)) return false;

  const staleAfterSeconds = Math.max(
    10,
    appSolo.heartbeatStaleAfterSeconds ?? APP_SOLO_HEARTBEAT_STALE_SECONDS
  );
  const staleForSeconds = Math.floor((nowMs - lastHeartbeatMs) / 1000);
  if (staleForSeconds <= staleAfterSeconds) return false;

  const pausedAt = new Date(nowMs).toISOString();
  await store.updateWorkbenchSession(session.id, {
    status: "paused",
    metadata: {
      ...session.metadata,
      appSolo: {
        ...appSolo,
        pausedAt,
        lastLifecycleEvent: "paused",
      },
    },
  });

  await store.addWorkbenchEvent({
    companyId: session.companyId,
    sessionId: session.id,
    type: "system",
    status: "needs_approval",
    title: "App Solo session paused",
    content: `No App Solo heartbeat received for ${staleForSeconds}s; session is paused for resume or cancel.`,
    metadata: {
      schemaVersion: "workbench.event.v1",
      reason: "heartbeat_stale",
      staleForSeconds,
      staleAfterSeconds,
      pausedAt,
    },
  });
  return true;
}

function requireAppSoloMetadata(session: WorkbenchSession): NonNullable<WorkbenchSession["metadata"]["appSolo"]> {
  const appSolo = session.metadata.appSolo;
  if (!appSolo) throw new Error(`Workbench session ${session.id} is not an App Solo run`);
  return appSolo;
}

export async function enqueueWorkbenchSession(
  sessionId: string
): Promise<void> {
  const session = await store.getWorkbenchSession(sessionId);
  if (!session) throw new Error(`Workbench session ${sessionId} not found`);

  await store.updateWorkbenchSession(sessionId, { status: "starting" });

  try {
    const provider = getWorkbenchProvider(session.provider);
    const checkpoint = await store.getWorkbenchCheckpoint(session.id).catch(() => undefined);
    const handle = checkpoint && provider.restore
      ? await provider.restore(session, checkpointToHandle(checkpoint))
      : await provider.start(session);

    if (handle) {
      await persistSandboxHandle(checkpoint, handle, session);
    }

    await store.updateWorkbenchSession(sessionId, {
      status: "running",
      startedAt: nowIso()
    });

    await store.addWorkbenchEvent({
      companyId: session.companyId,
      sessionId,
      type: "system",
      status: "completed",
      title: "Session started",
      content: "Sandbox environment is ready."
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Provider start failed";
    await store.updateWorkbenchSession(sessionId, {
      status: "failed",
      stoppedAt: nowIso()
    });
    await store.addWorkbenchEvent({
      companyId: session.companyId,
      sessionId,
      type: "system",
      status: "failed",
      title: "Session failed to start",
      content: message
    });
    throw err;
  }
}

export async function recordSessionSpend(
  sessionId: string,
  cents: number
): Promise<void> {
  if (cents === 0) return;

  const session = await store.getWorkbenchSession(sessionId);
  if (!session) return;

  const newCostCents = session.costCents + cents;
  await store.updateWorkbenchSession(sessionId, { costCents: newCostCents });

  await store.addUsage({
    companyId: session.companyId,
    category: "infra",
    description: `Workbench session ${sessionId}`,
    amountCents: cents,
    metadata: { sessionId, provider: session.provider }
  });

  if (newCostCents >= session.metadata.maxCostCents) {
    await stopWorkbenchSession(sessionId, "budget");
  }
}
