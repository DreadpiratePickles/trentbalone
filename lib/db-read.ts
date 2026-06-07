/**
 * Read-replica Prisma client.
 *
 * When READ_DATABASE_URL is set, SELECT queries are routed to the replica;
 * all writes go to the primary (DATABASE_URL).
 *
 * When READ_DATABASE_URL is absent, `readDb` is the same instance as
 * `db` (primary) so the code works in dev / test without a replica.
 *
 * Usage:
 *   import { readDb } from "@/lib/db-read";
 *   const tasks = await readDb.task.findMany({ where: { companyId } });
 */

import { PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";

// ── Read client ───────────────────────────────────────────────────────────────

let _readDb: PrismaClient | null = null;

function createReadClient(): PrismaClient {
  const url = process.env.READ_DATABASE_URL;
  if (!url) return db;

  return new PrismaClient({
    datasources: { db: { url } },
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

export const readDb: PrismaClient = (() => {
  if (!_readDb) _readDb = createReadClient();
  return _readDb;
})();

// ── Health check ──────────────────────────────────────────────────────────────

export type ReplicaHealthResult = {
  primary: "ok" | "error";
  replica: "ok" | "error" | "not_configured";
  replicaLagMs?: number;
};

/**
 * Ping both primary and replica.
 * Returns health status and replica lag when the replica is a Postgres instance.
 */
export async function checkReplicaHealth(): Promise<ReplicaHealthResult> {
  const result: ReplicaHealthResult = {
    primary: "error",
    replica: "not_configured",
  };

  // Primary
  try {
    await db.$queryRaw`SELECT 1`;
    result.primary = "ok";
  } catch {
    result.primary = "error";
  }

  // Replica (only when separately configured)
  if (process.env.READ_DATABASE_URL) {
    try {
      const start = Date.now();
      await readDb.$queryRaw`SELECT 1`;
      result.replica = "ok";
      result.replicaLagMs = Date.now() - start;
    } catch {
      result.replica = "error";
    }
  }

  return result;
}

// ── Replica lag query (Postgres only) ────────────────────────────────────────

/**
 * Query replication lag in bytes from the replica.
 * Returns null on SQLite or when no replica is configured.
 */
export async function getReplicaLagBytes(): Promise<number | null> {
  if (!process.env.READ_DATABASE_URL) return null;
  if (!process.env.READ_DATABASE_URL.startsWith("postgres")) return null;

  try {
    const rows = await readDb.$queryRaw<Array<{ lag: bigint | null }>>`
      SELECT pg_wal_lsn_diff(
        pg_current_wal_lsn(),
        pg_last_wal_replay_lsn()
      ) AS lag
    `;
    const lag = rows[0]?.lag;
    return lag != null ? Number(lag) : null;
  } catch {
    return null;
  }
}
