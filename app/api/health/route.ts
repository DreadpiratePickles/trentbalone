import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { checkBackupHealth } from "@/lib/backup-health";
import { buildHealthReadiness } from "@/lib/health-readiness";
import { isWorkerAlive, readWorkerHeartbeat } from "@/lib/worker-heartbeat";

// GET /api/health — liveness + readiness combined
export async function GET() {
  const checks: Record<string, "ok" | "degraded" | "unavailable"> = {
    app: "ok",
    database: "unavailable",
  };

  const readiness = buildHealthReadiness();
  const workerSeenAt = await readWorkerHeartbeat();

  // Database probe
  try {
    if (process.env.DATABASE_URL) {
      await db.$queryRaw`SELECT 1`;
      checks.database = "ok";
    } else {
      checks.database = "ok"; // in-memory store — always healthy
    }
  } catch {
    checks.database = "unavailable";
  }

  // Backup health probe
  const backup = checkBackupHealth();

  // Backup is optional infrastructure — only count it if it was actually configured.
  const backupConfigured = !!process.env.BACKUP_DIR?.trim();
  const allOk = Object.values(checks).every((v) => v === "ok") && (!backupConfigured || backup.ok);
  const status = allOk ? 200 : 503;

  return NextResponse.json(
    {
      status: allOk ? "ok" : "degraded",
      version: process.env.npm_package_version ?? "0.1.0",
      uptime: process.uptime(),
      checks,
      readiness,
      worker: {
        seenAt: workerSeenAt,
        alive: isWorkerAlive(workerSeenAt),
      },
      backup,
      ts: new Date().toISOString(),
    },
    { status }
  );
}
