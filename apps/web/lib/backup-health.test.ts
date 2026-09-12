// lib/backup-health.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { checkBackupHealth, simulateRestore, type BackupHealthResult } from "./backup-health";

// We pass a fake exec function directly to checkBackupHealth() instead of
// mocking the child_process module — Node built-in mocks are unreliable in
// Vitest's pool=forks mode.
//
// NOTE: vi.fn().mockImplementation(fn) in pool=forks mode re-surfaces errors
// thrown inside the implementation at the test-runner level even after they've
// been caught internally. We use plain stub functions for throw cases and
// vi.fn() only for the simple return-value case.

describe("checkBackupHealth", () => {
  // BACKUP_DIR must be set so the guard doesn't short-circuit to "not configured"
  beforeEach(() => { process.env.BACKUP_DIR = "/backups/test"; });
  afterEach(() => { delete process.env.BACKUP_DIR; });

  it("returns ok=true when BACKUP_DIR is not set (not configured)", () => {
    delete process.env.BACKUP_DIR;
    const exec = vi.fn();
    const result = checkBackupHealth(exec);
    expect(result.ok).toBe(true);
    expect((result as Extract<BackupHealthResult, { ok: true }>).path).toBe("not configured");
    expect(exec).not.toHaveBeenCalled();
  });

  it("returns ok=true when script exits 0 with valid JSON", () => {
    const payload = { ok: true, ageHours: 3.2, path: "/backups/trent.dump.enc" };
    const exec = vi.fn().mockReturnValue(Buffer.from(JSON.stringify(payload)));
    const result = checkBackupHealth(exec);
    expect(result.ok).toBe(true);
    expect((result as Extract<BackupHealthResult, { ok: true }>).ageHours).toBeCloseTo(3.2);
  });

  it("returns ok=false with error when script exits non-zero", () => {
    const staleErr = new Error("Command failed") as Error & { stdout: Buffer };
    staleErr.stdout = Buffer.from(
      JSON.stringify({ ok: false, error: "backup is stale", ageHours: 27.1, path: "/backups/x" })
    );
    const result = checkBackupHealth(() => { throw staleErr; });
    expect(result.ok).toBe(false);
    expect((result as Extract<BackupHealthResult, { ok: false }>).error).toBe("backup is stale");
  });

  it("returns ok=false with fallback error when stdout is unparseable", () => {
    const badErr = new Error("Command failed") as Error & { stdout: Buffer };
    badErr.stdout = Buffer.from("bash: command not found");
    const result = checkBackupHealth(() => { throw badErr; });
    expect(result.ok).toBe(false);
    expect((result as Extract<BackupHealthResult, { ok: false }>).error).toMatch(/parse/i);
  });
});

describe("simulateRestore", () => {
  it("returns ok=true and rowCount when restore script exits 0", () => {
    const payload = { ok: true, rowCount: 12345, durationMs: 4200 };
    const exec = vi.fn().mockReturnValue(Buffer.from(JSON.stringify(payload)));
    const result = simulateRestore(exec);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rowCount).toBe(12345);
      expect(result.durationMs).toBeGreaterThan(0);
    }
  });

  it("returns ok=false when restore script exits non-zero", () => {
    const err = new Error("Restore failed") as Error & { stdout: Buffer };
    err.stdout = Buffer.from(JSON.stringify({ ok: false, error: "pg_restore: connection refused", rowCount: 0, durationMs: 500 }));
    const result = simulateRestore(() => { throw err; });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/connection refused/i);
  });

  it("returns ok=false when restore output is unparseable", () => {
    const err = new Error("Failed") as Error & { stdout: Buffer };
    err.stdout = Buffer.from("not json");
    const result = simulateRestore(() => { throw err; });
    expect(result.ok).toBe(false);
  });
});
