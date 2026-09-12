/**
 * Builds a durable StorePort on a local SQLite file.
 *
 * Requires Bun: the driver adapter is bun:sqlite, which is what allows the CLI to be a
 * single compiled binary with no Rust query engine and no native .node module.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "./generated/client";
import { PrismaBunSQLite, DEFAULT_BUSY_TIMEOUT_MS } from "./bun-sqlite-adapter.mjs";
import { PrismaStore } from "./PrismaStore.js";
import type { StorePort } from "./StorePort.js";

export interface CreateStoreOptions {
  /** `file:/abs/path/trent.db` or a bare path. */
  url: string;
  /** Milliseconds a writer waits on a contended lock before SQLITE_BUSY. */
  busyTimeoutMs?: number;
  /**
   * DDL to apply when the database is empty. Defaults to the derived prisma/init.sql.
   * A compiled binary passes the embedded string instead, because `prisma migrate` needs
   * the Rust schema engine and that is not shipped.
   */
  initSql?: string;
}

const DDL_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../prisma/init.sql",
);

/** A table that only the derived schema creates, used as the "is this database set up" probe. */
const PROBE_TABLE = "OrchestratorRun";

export function readDerivedDdl(): string {
  return readFileSync(DDL_PATH, "utf8");
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
