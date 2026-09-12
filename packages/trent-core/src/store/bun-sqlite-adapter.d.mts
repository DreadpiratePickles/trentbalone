// Types for the vendored bun:sqlite driver adapter (bun-sqlite-adapter.mjs).
// Kept hand-written and deliberately narrow: the .mjs is vendored JS and must stay
// byte-comparable against Prisma's dist, so it carries no annotations of its own.

import type { SqlDriverAdapterFactory } from "@prisma/driver-adapter-utils";

export declare const ADAPTER_NAME: string;
export declare const WRITTEN_AGAINST_PRISMA_VERSION: string;
export declare const DEFAULT_BUSY_TIMEOUT_MS: number;

export interface BunSqliteConfig {
  /** `file:./trent.db` or a bare path. `:memory:` is accepted but defeats durability. */
  url: string;
  /** Milliseconds a writer waits on a contended lock before SQLITE_BUSY. */
  busyTimeoutMs?: number;
}

export interface BunSqliteAdapterOptions {
  timestampFormat?: "iso8601" | "unixepoch-ms";
  shadowDatabaseUrl?: string;
}

export declare class PrismaBunSQLite implements SqlDriverAdapterFactory {
  readonly provider: "sqlite";
  readonly adapterName: string;
  constructor(config: BunSqliteConfig, options?: BunSqliteAdapterOptions);
  connect(): ReturnType<SqlDriverAdapterFactory["connect"]>;
  connectToShadowDb(): ReturnType<SqlDriverAdapterFactory["connect"]>;
}
