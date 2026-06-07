// lib/backup-health.ts
//
// Thin TypeScript wrapper around scripts/backup/pg-backup-health.sh.
// Used by app/api/health/route.ts to include backup freshness in the
// health check response.
//
import { execSync as _execSync } from "child_process";
import path from "path";

export type BackupHealthResult =
  | { ok: true; ageHours: number; path: string }
  | { ok: false; error: string; ageHours: number | null; path: string | null };

export type RestoreResult =
  | { ok: true; rowCount: number; durationMs: number }
  | { ok: false; error: string; rowCount: number; durationMs: number };

type ExecFn = (cmd: string, opts: object) => Buffer;

const SCRIPT = path.resolve(process.cwd(), "scripts/backup/pg-backup-health.sh");
const RESTORE_SCRIPT = path.resolve(process.cwd(), "scripts/backup/pg-restore-test.sh");

export function checkBackupHealth(
  // Dependency-injected executor — real execSync by default, overridable in tests
  exec: ExecFn = _execSync as ExecFn
): BackupHealthResult {
  // If BACKUP_DIR is not set, backups are not configured for this environment.
  // Treat as ok (not a failure) so the health endpoint stays green on Railway
  // and other environments that don't run a backup agent.
  if (!process.env.BACKUP_DIR?.trim()) {
    return { ok: true, ageHours: 0, path: "not configured" };
  }

  const env = {
    ...process.env,
    BACKUP_DIR: process.env.BACKUP_DIR,
    MAX_AGE_HOURS: process.env.BACKUP_MAX_AGE_HOURS ?? "25",
  };

  try {
    const stdout = exec(`bash "${SCRIPT}"`, { env, stdio: ["ignore", "pipe", "pipe"] });
    return JSON.parse(stdout.toString().trim()) as BackupHealthResult;
  } catch (err: unknown) {
    // Script exited non-zero — try to parse its JSON stdout
    const raw = (err as { stdout?: Buffer }).stdout?.toString().trim() ?? "";
    try {
      return JSON.parse(raw) as BackupHealthResult;
    } catch {
      return {
        ok: false,
        error: `Failed to parse backup health output: ${raw.slice(0, 200)}`,
        ageHours: null,
        path: null,
      };
    }
  }
}

/**
 * Simulate a restore to a scratch database and verify row count.
 * Delegates to scripts/backup/pg-restore-test.sh which must:
 *   - Restore the latest backup into a temp DB
 *   - Emit JSON: { ok: bool, rowCount: number, durationMs: number, error?: string }
 *   - Exit 0 on success, non-zero on failure
 */
export function simulateRestore(
  exec: ExecFn = _execSync as ExecFn
): RestoreResult {
  const env = { ...process.env, BACKUP_DIR: process.env.BACKUP_DIR ?? "" };
  try {
    const stdout = exec(`bash "${RESTORE_SCRIPT}"`, { env, stdio: ["ignore", "pipe", "pipe"] });
    return JSON.parse(stdout.toString().trim()) as RestoreResult;
  } catch (err: unknown) {
    const raw = (err as { stdout?: Buffer }).stdout?.toString().trim() ?? "";
    try {
      return JSON.parse(raw) as RestoreResult;
    } catch {
      return {
        ok: false,
        error: `Failed to parse restore output: ${raw.slice(0, 200)}`,
        rowCount: 0,
        durationMs: 0,
      };
    }
  }
}
