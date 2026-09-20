/**
 * The one answer to "can the app's store work in this process?", and the guard that keeps the
 * app's Postgres client from being constructed when it cannot.
 *
 * `apps/web/lib/store.ts:11` selects the Prisma store whenever `DATABASE_URL` is truthy, and
 * `apps/web/lib/db.ts:8` builds that client for a POSTGRESQL datasource. The wrapper's own store is
 * SQLite under `<profile>/trent.db`; its URL is not the app's, and handing it over as
 * `DATABASE_URL` sent every app-store call into a client that cannot take it. The predicate below
 * is what every reader, writer and the doctor consult BEFORE any `import("@/lib/*")`.
 */
import { afterEach, describe, expect, it } from "vitest";

import { AppStoreUnusedError, appStoreUsable, describeAppStore, guardAppDatabase, isAppDatabaseGuard } from "./app-store.js";

const PRISMA_GLOBAL = "__prisma";

function globalPrisma(): unknown {
  return (globalThis as Record<string, unknown>)[PRISMA_GLOBAL];
}

afterEach(() => {
  if (isAppDatabaseGuard(globalPrisma())) delete (globalThis as Record<string, unknown>)[PRISMA_GLOBAL];
});

describe("describeAppStore", () => {
  it("is usable only for a postgres URL, which is the app's own datasource", () => {
    for (const url of ["postgresql://localhost/trent", "postgres://u:p@db:5432/trent", "prisma+postgres://accelerate/x", "POSTGRESQL://upper"]) {
      const state = describeAppStore({ DATABASE_URL: url });
      expect(state.usable, url).toBe(true);
      if (state.usable) {
        expect(state.store).toBe("server");
        expect(state.url).toBe(url);
      }
    }
  });

  it("says unset and empty are the in-process store, with the reason a seat's row would not outlive the process", () => {
    for (const env of [{}, { DATABASE_URL: "" }, { DATABASE_URL: "   " }]) {
      const state = describeAppStore(env);
      expect(state.usable).toBe(false);
      if (!state.usable) {
        expect(state.store).toBe("memory");
        expect(state.reason).toContain("unset");
        expect(state.reason).toContain("in-process");
      }
    }
  });

  it("says a file: URL is the wrapper's SQLite store and not the app's, whatever the case of the scheme", () => {
    for (const url of ["file:/Users/x/.trent/default/trent.db", "FILE:./trent.db", " file:relative.db"]) {
      const state = describeAppStore({ DATABASE_URL: url });
      expect(state.usable, url).toBe(false);
      if (!state.usable) {
        expect(state.store).toBe("sqlite");
        expect(state.reason).toContain("SQLite");
        expect(state.reason).toContain("postgresql");
        // The value never leaves the predicate: a URL can carry a password.
        expect(state.reason).not.toContain("/Users/x");
      }
    }
  });

  it("names the scheme of any other URL and refuses it, because the app's client is postgresql", () => {
    const state = describeAppStore({ DATABASE_URL: "mysql://secret@host/db" });
    expect(state.usable).toBe(false);
    if (!state.usable) {
      expect(state.store).toBe("unsupported");
      expect(state.reason).toContain("mysql:");
      expect(state.reason).not.toContain("secret");
    }
  });

  it("reads process.env when handed nothing", () => {
    expect(appStoreUsable({})).toBe(false);
    expect(appStoreUsable({ DATABASE_URL: "postgresql://localhost/trent" })).toBe(true);
    expect(typeof appStoreUsable()).toBe("boolean");
  });
});

describe("guardAppDatabase", () => {
  it("fills the app's own singleton seam with a guard when the store is not usable, and says why", () => {
    const state = guardAppDatabase({ DATABASE_URL: "file:/tmp/trent.db" });
    expect(state.usable).toBe(false);
    const guard = globalPrisma();
    expect(isAppDatabaseGuard(guard)).toBe(true);
    // `db.ts` does `globalThis.__prisma ?? new PrismaClient()`: the guard is what the app gets.
    expect(Boolean(guard)).toBe(true);
    // Any use is a plain, immediate error carrying the reason — never a Prisma engine error.
    expect(() => (guard as { company: unknown }).company).toThrow(AppStoreUnusedError);
    expect(() => (guard as { $transaction: unknown }).$transaction).toThrow(/SQLite/);
  });

  it("is safe to await and to inspect, so the seam assignment in db.ts and a debugger do not throw", async () => {
    guardAppDatabase({});
    const guard = globalPrisma() as Record<string | symbol, unknown>;
    expect(guard.then).toBeUndefined();
    expect(guard[Symbol.toStringTag]).toBe("TrentAppDatabaseGuard");
    expect((await Promise.resolve(guard)) === guard).toBe(true);
    expect(String(guard)).toContain("TrentAppDatabaseGuard");
  });

  it("removes its own guard, and only its own, when the store becomes usable", () => {
    guardAppDatabase({});
    expect(isAppDatabaseGuard(globalPrisma())).toBe(true);
    const state = guardAppDatabase({ DATABASE_URL: "postgresql://localhost/trent" });
    expect(state.usable).toBe(true);
    expect(globalPrisma()).toBeUndefined();

    const real = { $transaction: () => undefined };
    (globalThis as Record<string, unknown>)[PRISMA_GLOBAL] = real;
    guardAppDatabase({});
    expect(globalPrisma() === real).toBe(true);
    guardAppDatabase({ DATABASE_URL: "postgresql://localhost/trent" });
    expect(globalPrisma() === real).toBe(true);
    delete (globalThis as Record<string, unknown>)[PRISMA_GLOBAL];
  });

  it("is idempotent: a second call keeps the same guard", () => {
    guardAppDatabase({});
    const first = globalPrisma();
    guardAppDatabase({ DATABASE_URL: "" });
    expect(globalPrisma() === first).toBe(true);
  });
});
