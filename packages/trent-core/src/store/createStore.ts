/**
 * Builds a durable StorePort on a local SQLite file.
 *
 * Requires Bun: the driver adapter is bun:sqlite, which is what allows the CLI to be a
 * single compiled binary with no Rust query engine and no native .node module.
 */

import { PrismaClient } from "./generated/client";
import { DERIVED_DDL } from "./derived-ddl.js";
import { PrismaBunSQLite, DEFAULT_BUSY_TIMEOUT_MS } from "./bun-sqlite-adapter.mjs";
import { PrismaStore } from "./PrismaStore.js";
import type { StorePort } from "./StorePort.js";

export interface CreateStoreOptions {
  /** `file:/abs/path/trent.db` or a bare path. */
  url: string;
  /** Milliseconds a writer waits on a contended lock before SQLITE_BUSY. */
  busyTimeoutMs?: number;
  /**
   * DDL to apply when the database is empty. Defaults to the derived DDL embedded in the
   * bundle (`derived-ddl.ts`), applied through the adapter because `prisma migrate` needs the
   * Rust schema engine and that is not shipped.
   */
  initSql?: string;
}

/** A table that only the derived schema creates, used as the "is this database set up" probe. */
const PROBE_TABLE = "OrchestratorRun";

/**
 * The derived DDL. It is never read from disk: inside a compiled binary `import.meta.url`
 * resolves into the compiled filesystem, where `../../prisma/init.sql` does not exist, and the
 * ENOENT made every shipped binary fall back to the in-memory store. The generated module is
 * written by `scripts/derive-sqlite-schema.mjs` from the same string as `prisma/init.sql`.
 */
export function readDerivedDdl(): string {
  return DERIVED_DDL;
}

async function ensureSchema(factory: PrismaBunSQLite, ddl: string): Promise<void> {
  const connection = await factory.connect();
  try {
    const probe = await connection.queryRaw({
      sql: `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${PROBE_TABLE}'`,
      args: [],
      argTypes: [],
    });
    if (probe.rows.length === 0) {
      await connection.executeScript(ddl);
    }
  } finally {
    await connection.dispose();
  }
}

export async function createSqliteStore(options: CreateStoreOptions): Promise<StorePort> {
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  await ensureSchema(
    new PrismaBunSQLite({ url: options.url, busyTimeoutMs }),
    options.initSql ?? readDerivedDdl(),
  );

  const adapter = new PrismaBunSQLite({ url: options.url, busyTimeoutMs });
  const prisma = new PrismaClient({ adapter });
  return new PrismaStore(prisma);
}
