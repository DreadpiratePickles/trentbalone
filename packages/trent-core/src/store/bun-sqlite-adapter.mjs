// Prisma SqlDriverAdapter over bun:sqlite.
//
// Written against Prisma 6.19.3. The conversion and error helpers are vendored verbatim
// from @prisma/adapter-better-sqlite3 6.19.3 (see bun-sqlite-conversion.mjs); only the
// bun:sqlite plumbing below is ours. Re-verify both on every Prisma bump.
//
// Why it exists: `engineType = "client"` removes Prisma's Rust query engine, which is what
// lets the CLI ship as a single compiled Bun binary. Prisma then needs a JS driver adapter,
// and no official bun:sqlite one exists. better-sqlite3 and libsql are native modules that
// bun --compile cannot embed; bun:sqlite is built into the runtime, so it can.
//
// TRANSACTION SEMANTICS - the two things that are easy to get wrong:
//   * startTransaction() must issue BEGIN itself.
//   * commit()/rollback() must ONLY release the mutex. With `usePhantomQuery: false`
//     Prisma emits COMMIT/ROLLBACK as ordinary queries; issuing them here as well throws
//     "no transaction is active" and Prisma reports P2028.
//
// IMPORTABLE WITHOUT BUN: `bun:sqlite` is imported lazily inside connect(), so this module
// can be imported (and type-checked, and unit-tested) under Node. Only connect() needs Bun.

import { DriverAdapterError, Debug } from "@prisma/driver-adapter-utils";
import { getColumnTypes, mapArg, mapRow, convertDriverError } from "./bun-sqlite-conversion.mjs";

const debug = Debug("prisma:driver-adapter:bun-sqlite");

export const ADAPTER_NAME = "@trent/adapter-bun-sqlite";
export const WRITTEN_AGAINST_PRISMA_VERSION = "6.19.3";

/** Default milliseconds a connection waits on a locked database before SQLITE_BUSY. */
export const DEFAULT_BUSY_TIMEOUT_MS = 5000;

/** Serializes transactions on a single connection: bun:sqlite has no nested BEGIN. */
class Mutex {
  #tail = Promise.resolve();

  acquire() {
    let release;
    const next = new Promise((resolve) => {
      release = () => resolve();
    });
    const previous = this.#tail;
    this.#tail = previous.then(() => next);
    return previous.then(() => release);
  }
}

class BunSqliteQueryable {
  provider = "sqlite";
  adapterName = ADAPTER_NAME;

  constructor(client, adapterOptions = {}) {
    this.client = client;
    this.adapterOptions = adapterOptions;
  }

  #prepare(query) {
    const args = query.args.map((arg, i) => mapArg(arg, query.argTypes[i], this.adapterOptions));
    return { stmt: this.client.prepare(query.sql), args };
  }

  async queryRaw(query) {
    try {
      const { stmt, args } = this.#prepare(query);
      const values = stmt.values(...args);
      const columnNames = stmt.columnNames;
      if (columnNames.length === 0) {
        return { columnNames: [], columnTypes: [], rows: [] };
      }
      let declaredTypes;
      try {
        declaredTypes = stmt.declaredTypes;
      } catch {
        declaredTypes = columnNames.map(() => null);
      }
      const columnTypes = getColumnTypes(declaredTypes, values);
      return { columnNames, columnTypes, rows: values.map((row) => mapRow(row, columnTypes)) };
    } catch (error) {
      this.onError(error);
    }
  }

  async executeRaw(query) {
    try {
      const { stmt, args } = this.#prepare(query);
      return Number(stmt.run(...args).changes);
    } catch (error) {
      this.onError(error);
    }
  }

  onError(error) {
    debug("error in performIO: %O", error);
    throw new DriverAdapterError(convertDriverError(error));
  }
}

class BunSqliteTransaction extends BunSqliteQueryable {
  #release;

  constructor(client, options, adapterOptions, releaseMutex) {
    super(client, adapterOptions);
    this.options = options;
    this.#release = releaseMutex;
  }

  // Prisma sends COMMIT / ROLLBACK itself because usePhantomQuery is false.
  // Do not issue them here as well - see the header note about P2028.
  async commit() {
    this.#release();
  }

  async rollback() {
    this.#release();
  }
}

class BunSqliteAdapter extends BunSqliteQueryable {
  #mutex = new Mutex();

  async executeScript(script) {
    try {
      this.client.exec(script);
    } catch (error) {
      this.onError(error);
    }
  }

  async startTransaction(isolationLevel) {
    if (isolationLevel && isolationLevel !== "SERIALIZABLE") {
      throw new DriverAdapterError({ kind: "InvalidIsolationLevel", level: isolationLevel });
    }
    const release = await this.#mutex.acquire();
    try {
      this.client.prepare("BEGIN").run();
      return new BunSqliteTransaction(
        this.client,
        { usePhantomQuery: false },
        this.adapterOptions,
        release,
      );
    } catch (error) {
      release();
      this.onError(error);
    }
  }

  async dispose() {
    this.client.close();
  }
}

/**
 * Concurrency hardening (review finding C4). WAL lets one writer and many readers proceed
 * at once instead of taking a whole-database lock, and busy_timeout makes a writer wait for
 * a contended lock rather than failing immediately with SQLITE_BUSY.
 */
function applyPragmas(db, busyTimeoutMs) {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`PRAGMA busy_timeout = ${Number(busyTimeoutMs)};`);
  db.exec("PRAGMA foreign_keys = ON;");
}

export class PrismaBunSQLite {
  provider = "sqlite";
  adapterName = ADAPTER_NAME;

  constructor(config, options = {}) {
    this.config = config;
    this.options = options;
  }

  async #open(url) {
    // bun:sqlite only exists under Bun. Imported here, not at module scope, so this file
    // stays importable under Node.
    const { Database } = await import(/* @vite-ignore */ "bun:sqlite");
    const db = new Database(url.replace(/^file:/, ""), { safeIntegers: true, strict: false });
    applyPragmas(db, this.config.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS);
    return new BunSqliteAdapter(db, this.options);
  }

  async connect() {
    return this.#open(this.config.url);
  }

  async connectToShadowDb() {
    return this.#open(this.options?.shadowDatabaseUrl ?? ":memory:");
  }
}
