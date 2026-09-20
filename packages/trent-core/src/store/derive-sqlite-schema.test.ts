import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "../..");
const repoRoot = path.resolve(pkgRoot, "../..");
const script = path.join(pkgRoot, "scripts/derive-sqlite-schema.mjs");
const canonical = path.join(repoRoot, "apps/web/prisma/schema.prisma");
const derived = path.join(pkgRoot, "prisma/schema.sqlite.prisma");

function runDerive(): void {
  execFileSync(process.execPath, [script], { cwd: repoRoot, stdio: "pipe" });
}

describe("derive-sqlite-schema", () => {
  let first = "";

  beforeAll(() => {
    runDerive();
    first = readFileSync(derived, "utf8");
  });

  it("writes the derived schema next to the package", () => {
    expect(existsSync(derived)).toBe(true);
    expect(first.length).toBeGreaterThan(0);
  });

  it("is idempotent: a second run reproduces the file byte for byte", () => {
    runDerive();
    const second = readFileSync(derived, "utf8");
    expect(second).toBe(first);
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
    const ddl = readFileSync(path.join(pkgRoot, "prisma/init.sql"), "utf8");
    expect(ddl).toMatch(/CREATE TABLE "OrchestratorRun"/);
    expect(ddl).toMatch(/CREATE TABLE "Approval"/);
    expect(ddl).toMatch(/ON DELETE CASCADE/);
  });

  it("emits the same DDL as a TypeScript module, so a compiled binary carries it", () => {
    const ddl = readFileSync(path.join(pkgRoot, "prisma/init.sql"), "utf8");
    const module = readFileSync(path.join(pkgRoot, "src/store/derived-ddl.ts"), "utf8");
    expect(module).toContain("GENERATED FILE - DO NOT EDIT");
    expect(module).toContain(`export const DERIVED_DDL: string = ${JSON.stringify(ddl)};`);
  });

  it("quotes Json column defaults, which prisma emits unquoted and sqlite rejects", () => {
    const ddl = readFileSync(path.join(pkgRoot, "prisma/init.sql"), "utf8");
    expect(ddl).not.toMatch(/DEFAULT (\{|\[)/);
    expect(ddl).toMatch(/DEFAULT '\[\]'/);
  });
});
