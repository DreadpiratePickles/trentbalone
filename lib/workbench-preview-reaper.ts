/**
 * Workbench preview reaper
 *
 * Background preview processes (`npm run dev`, the static node server) are spawned
 * detached on non-Windows hosts and tracked only in an in-memory map inside
 * `workbench-local-provider.ts`. On a server/container restart that map is cleared,
 * but the spawned processes keep running and hold ports 4100–4199.
 *
 * To make those processes reapable across restarts, the provider writes a small
 * JSON sidecar (`.trent-preview.json`) into each session workdir right after it
 * spawns a background preview. This module reads those sidecars and kills the
 * orphaned processes.
 *
 * The kill/liveness/clock primitives are injectable so the helpers can be tested
 * without spawning or killing real processes.
 */

import * as fs from "fs/promises";
import * as path from "path";

export const PREVIEW_PID_FILENAME = ".trent-preview.json";

/** Default max age before a still-alive preview is considered orphaned (6h). */
export const DEFAULT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export type PreviewPidRecord = {
  pid: number;
  port: number;
  startedAt: string;
};

export type ReapOptions = {
  isAlive?(pid: number): boolean;
  kill?(pid: number): void;
  now?: Date;
  maxAgeMs?: number;
};

/**
 * Safely parse the sidecar contents into a PreviewPidRecord.
 * Pure: returns undefined on malformed JSON or wrong shape.
 */
export function parsePreviewPidFile(contents: string): PreviewPidRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const rec = parsed as Record<string, unknown>;
  if (typeof rec.pid !== "number" || !Number.isInteger(rec.pid) || rec.pid <= 0) return undefined;
  if (typeof rec.port !== "number" || !Number.isInteger(rec.port)) return undefined;
  if (typeof rec.startedAt !== "string" || rec.startedAt.length === 0) return undefined;
  return { pid: rec.pid, port: rec.port, startedAt: rec.startedAt };
}

/**
 * Whether a process with the given pid is currently alive.
 * `process.kill(pid, 0)` works on both Windows and POSIX: it sends no signal but
 * throws ESRCH if the process does not exist (or EPERM if it exists but we can't
 * signal it — in which case it IS alive).
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means the process exists but we lack permission to signal it.
    if (code === "EPERM") return true;
    return false;
  }
}

function defaultKill(pid: number): void {
  process.kill(pid);
}

/**
 * Inspect a single session dir's preview sidecar and reap the recorded process if
 * it is orphaned. A process is reaped when:
 *   - the owning process is already gone (sidecar is stale), or
 *   - the process is still alive but older than maxAgeMs.
 * The sidecar is always removed once handled. Best-effort: never throws.
 */
export async function reapOrphanedPreview(
  sessionDir: string,
  opts?: ReapOptions
): Promise<{ reaped: boolean; pid?: number; reason?: string }> {
  const isAlive = opts?.isAlive ?? isProcessAlive;
  const kill = opts?.kill ?? defaultKill;
  const now = opts?.now ?? new Date();
  const maxAgeMs = opts?.maxAgeMs ?? DEFAULT_MAX_AGE_MS;

  const sidecarPath = path.join(sessionDir, PREVIEW_PID_FILENAME);

  let contents: string;
  try {
    contents = await fs.readFile(sidecarPath, "utf8");
  } catch {
    // No sidecar — nothing to reap.
    return { reaped: false, reason: "no_sidecar" };
  }

  const record = parsePreviewPidFile(contents);
  if (!record) {
    // Malformed sidecar — clean it up so it doesn't linger.
    await fs.rm(sidecarPath, { force: true }).catch(() => {});
    return { reaped: false, reason: "malformed_sidecar" };
  }

  const alive = (() => {
    try {
      return isAlive(record.pid);
    } catch {
      return false;
    }
  })();

  const startedMs = new Date(record.startedAt).getTime();
  const ageMs = Number.isFinite(startedMs) ? now.getTime() - startedMs : Number.POSITIVE_INFINITY;
  // `>=` so that maxAgeMs: 0 (the stale-on-restart path: "reap regardless of age")
  // reaps even when the sidecar was just written (ageMs === 0).
  const tooOld = ageMs >= maxAgeMs;

  if (alive && !tooOld) {
    // Healthy and recent — leave it running, keep the sidecar.
    return { reaped: false, pid: record.pid, reason: "alive_and_recent" };
  }

  if (alive && tooOld) {
    try {
      kill(record.pid);
    } catch {
      // Best-effort: process may have exited between the liveness check and kill.
    }
  }

  await fs.rm(sidecarPath, { force: true }).catch(() => {});
  return { reaped: true, pid: record.pid, reason: alive ? "killed_stale_aged" : "owner_gone" };
}

/**
 * Scan every session dir under sessionsRoot and reap orphaned previews.
 * Returns the number of processes/sidecars reaped. Best-effort: never throws.
 */
export async function reapAllOrphanedPreviews(
  sessionsRoot: string,
  opts?: ReapOptions
): Promise<number> {
  let entries: import("fs").Dirent[] = [];
  try {
    entries = await fs.readdir(sessionsRoot, { withFileTypes: true });
  } catch {
    return 0;
  }

  let reaped = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sessionDir = path.join(sessionsRoot, entry.name);
    try {
      const result = await reapOrphanedPreview(sessionDir, opts);
      if (result.reaped) reaped++;
    } catch {
      // Best-effort per-session; keep scanning.
    }
  }
  return reaped;
}
