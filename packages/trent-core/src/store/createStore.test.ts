/**
 * The derived DDL is EMBEDDED, not read off the disk at run time.
 *
 * Inside a `bun build --compile` binary `import.meta.url` resolves into the compiled filesystem,
 * where `../../prisma/init.sql` does not exist (`/prisma/init.sql`: ENOENT). Reading the DDL
 * from a path therefore made `createSqliteStore` fail in every binary, `openStore` fell back to
 * `EphemeralStore`, and no user of the shipped CLI ever had a durable store. The DDL now travels
 * as a generated TypeScript module (`derived-ddl.ts`, written by
 * `scripts/derive-sqlite-schema.mjs` in the same breath as `prisma/init.sql`), so the bundler
 * carries it wherever the code goes.
 */
import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");

// Every path is absent: the file system a compiled binary sees for `../../prisma/init.sql`.
vi.mock("node:fs", async () => {
  const real = await vi.importActual<typeof import("node:fs")>("node:fs");
  const enoent = (file: unknown): never => {
    const error = new Error(`ENOENT: no such file or directory, open '${String(file)}'`) as NodeJS.ErrnoException;
    error.code = "ENOENT";
    throw error;
  };
  return { ...real, default: { ...real, readFileSync: enoent }, readFileSync: enoent };
});

const here = path.dirname(fileURLToPath(import.meta.url));
const initSql = path.resolve(here, "../../prisma/init.sql");

describe("readDerivedDdl", () => {
  it("resolves the DDL with no readable init.sql anywhere on disk", async () => {
    const { readDerivedDdl } = await import("./createStore.js");
    const ddl = readDerivedDdl();
    expect(ddl).toMatch(/CREATE TABLE "OrchestratorRun"/);
    expect(ddl).toMatch(/CREATE TABLE "Approval"/);
  });

  it("is byte for byte the DDL the derive script wrote to prisma/init.sql", async () => {
    const { readDerivedDdl } = await import("./createStore.js");
    expect(readDerivedDdl()).toBe(actualFs.readFileSync(initSql, "utf8"));
  });
});
