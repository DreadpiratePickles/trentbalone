import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, statSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "../..");
const repoRoot = path.resolve(pkgRoot, "../..");
const script = path.join(pkgRoot, "scripts/derive-sqlite-schema.mjs");
const canonical = path.join(repoRoot, "apps/web/prisma/schema.prisma");

/** The derived outputs that are committed, as paths relative to the package (or an --out-root). */
const SCHEMA = "prisma/schema.sqlite.prisma";
const INIT_SQL = "prisma/init.sql";
const DDL_MODULE = "src/store/derived-ddl.ts";

/**
 * Files other suites read while this one runs. Every Bun child (approvals.restart, audit,
 * store.durability, app-memory.bun) imports the generated client, and `prisma generate` deletes
 * and recreates each file of its output: deriving in place once killed a concurrent child with
 * "Cannot find module './internal/class'" (docs/sessions/2026-09-26-approvals-restart-flake.md).
 */
const SHARED = [
  "src/store/generated/client.ts",
  "src/store/generated/internal/class.ts",
  SCHEMA,
  INIT_SQL,
  DDL_MODULE,
];

/** Each shared file's identity on disk (inode and mtime), or "absent". Any rewrite changes it. */
function identities(): Record<string, string> {
  return Object.fromEntries(
    SHARED.map((rel) => {
      const file = path.join(pkgRoot, rel);
      if (!existsSync(file)) return [rel, "absent"];
      const stat = statSync(file, { bigint: true });
      return [rel, `ino=${stat.ino} mtimeNs=${stat.mtimeNs}`];
    }),
  );
}

describe("derive-sqlite-schema", () => {
  let outRoot = "";
  let first = "";
  let sharedBefore: Record<string, string> = {};
  const out = (rel: string): string => path.join(outRoot, rel);
  const runDerive = (): void => {
    execFileSync(process.execPath, [script, "--out-root", outRoot], { cwd: repoRoot, stdio: "pipe" });
  };

  beforeAll(() => {
    sharedBefore = identities();
    outRoot = mkdtempSync(path.join(os.tmpdir(), "trent-derive-sqlite-"));
    runDerive();
    first = readFileSync(out(SCHEMA), "utf8");
  });

  afterAll(() => {
    if (outRoot !== "") rmSync(outRoot, { recursive: true, force: true });
  });

  it("writes the derived schema under its output root", () => {
    expect(existsSync(out(SCHEMA))).toBe(true);
    expect(first.length).toBeGreaterThan(0);
  });

  it("is idempotent: a second run reproduces the file byte for byte", () => {
    runDerive();
    const second = readFileSync(out(SCHEMA), "utf8");
    expect(second).toBe(first);
  });

  it("derives exactly the committed schema, DDL and DDL module (rerun the script if this fails)", () => {
    for (const rel of [SCHEMA, INIT_SQL, DDL_MODULE]) {
      expect(readFileSync(out(rel), "utf8"), rel).toBe(readFileSync(path.join(pkgRoot, rel), "utf8"));
    }
  });

  it("generates the client in the same breath, beside the schema it came from", () => {
    expect(existsSync(out("src/store/generated/client.ts"))).toBe(true);
    expect(existsSync(out("src/store/generated/internal/class.ts"))).toBe(true);
  });

  it("targets sqlite with a file: url from the environment", () => {
    expect(first).toContain('provider = "sqlite"');
    expect(first).not.toContain('provider = "postgresql"');
    expect(first).toContain('url      = env("TRENT_SQLITE_URL")');
  });

  it("drops directUrl, which sqlite does not accept", () => {
    expect(first).not.toContain("directUrl");
  });

  it("uses the client-engine generator so no Rust query engine is needed", () => {
    expect(first).toContain('provider   = "prisma-client"');
    expect(first).toContain('engineType = "client"');
    expect(first).toContain('runtime    = "bun"');
    expect(first).toContain('output     = "../src/store/generated"');
    expect(first).not.toContain("prisma-client-js");
  });

  it("carries no postgres-only native type attributes", () => {
    expect(first).not.toMatch(/@db\./);
  });

  it("keeps every model from the canonical schema", () => {
    const count = (src: string): number => (src.match(/^model \w+ \{/gm) ?? []).length;
    expect(count(first)).toBe(count(readFileSync(canonical, "utf8")));
  });

  it("emits the DDL used to create the database at runtime", () => {
    const ddl = readFileSync(out(INIT_SQL), "utf8");
    expect(ddl).toMatch(/CREATE TABLE "OrchestratorRun"/);
    expect(ddl).toMatch(/CREATE TABLE "Approval"/);
    expect(ddl).toMatch(/ON DELETE CASCADE/);
  });

  it("emits the same DDL as a TypeScript module, so a compiled binary carries it", () => {
    const ddl = readFileSync(out(INIT_SQL), "utf8");
    const module = readFileSync(out(DDL_MODULE), "utf8");
    expect(module).toContain("GENERATED FILE - DO NOT EDIT");
    expect(module).toContain(`export const DERIVED_DDL: string = ${JSON.stringify(ddl)};`);
  });

  it("quotes Json column defaults, which prisma emits unquoted and sqlite rejects", () => {
    const ddl = readFileSync(out(INIT_SQL), "utf8");
    expect(ddl).not.toMatch(/DEFAULT (\{|\[)/);
    expect(ddl).toMatch(/DEFAULT '\[\]'/);
  });

  it("refuses an argument it does not know instead of deriving in place", () => {
    expect(() => execFileSync(process.execPath, [script, "--out", outRoot], { cwd: repoRoot, stdio: "pipe" })).toThrow(
      /usage: derive-sqlite-schema\.mjs \[--out-root <dir>\]/,
    );
  });

  // Last on purpose: it sees every derive this file ran, including one a broken argument check
  // would have let through in place.
  it("never rewrites a file that other suites read while it runs", () => {
    expect(identities()).toEqual(sharedBefore);
  });
});
