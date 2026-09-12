import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("bun:sqlite adapter module", () => {
  it("imports under Node, where bun:sqlite does not exist", async () => {
    // The whole point of the lazy `await import("bun:sqlite")` inside connect(): this file
    // must be loadable and type-checkable off Bun, or nothing here can be tested at all.
    const mod = await import("./bun-sqlite-adapter.mjs");
    expect(typeof mod.PrismaBunSQLite).toBe("function");
    expect(new mod.PrismaBunSQLite({ url: "file::memory:" }).provider).toBe("sqlite");
  });

  it("refuses to connect off Bun rather than silently degrading", async () => {
    const { PrismaBunSQLite } = await import("./bun-sqlite-adapter.mjs");
    await expect(new PrismaBunSQLite({ url: "file::memory:" }).connect()).rejects.toThrow();
  });

  it("stamps the Prisma version its vendored helpers were lifted from", async () => {
    const { WRITTEN_AGAINST_PRISMA_VERSION } = await import("./bun-sqlite-adapter.mjs");
    const installed = JSON.parse(
      readFileSync(path.resolve(here, "../../../../node_modules/prisma/package.json"), "utf8"),
    ) as { version: string };
    // If this fails, Prisma was upgraded: re-diff bun-sqlite-conversion.mjs against
    // node_modules/@prisma/adapter-better-sqlite3/dist/index.mjs before bumping the stamp.
    expect(WRITTEN_AGAINST_PRISMA_VERSION).toBe(installed.version);
  });

  it("keeps the vendored helpers stamped with their source", () => {
    const vendored = readFileSync(path.join(here, "bun-sqlite-conversion.mjs"), "utf8");
    expect(vendored).toContain("@prisma/adapter-better-sqlite3");
    expect(vendored).toContain("6.19.3");
  });

  it("only releases the mutex on commit and rollback", () => {
    // usePhantomQuery:false means Prisma emits COMMIT/ROLLBACK itself. Issuing them here as
    // well throws "no transaction is active", which Prisma reports as P2028.
    const source = readFileSync(path.join(here, "bun-sqlite-adapter.mjs"), "utf8");
    const tx = source.slice(source.indexOf("class BunSqliteTransaction"));
    const body = tx.slice(0, tx.indexOf("class BunSqliteAdapter"));
    expect(body).not.toMatch(/"COMMIT"|'COMMIT'/);
    expect(body).not.toMatch(/"ROLLBACK"|'ROLLBACK'/);
    expect(source).toMatch(/startTransaction[\s\S]*?prepare\("BEGIN"\)/);
  });
});
