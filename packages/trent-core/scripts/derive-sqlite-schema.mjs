#!/usr/bin/env node
// Derives packages/trent-core/prisma/schema.sqlite.prisma from the canonical
// apps/web/prisma/schema.prisma.
//
// This script is the artifact. The derived schema is generated output and must never be
// hand-edited: the two schemas cannot drift if the only way to produce one is to run this.
//
// What it changes, and nothing else:
//   1. the generator block  -> prisma-client with engineType="client", runtime="bun"
//      (the client engine is what removes the Rust query engine, so the CLI can be a
//       single compiled binary — see 01_discovery/output/spike-prisma-results.md)
//   2. the datasource block -> provider "sqlite", url from env("TRENT_SQLITE_URL"),
//      directUrl dropped (sqlite has no such concept)
//   3. any @db.* native type attribute is stripped (postgres-only; the canonical schema
//      currently has none, and the test asserts none survive)
//
// It also writes prisma/init.sql — the full DDL — because `prisma migrate` needs the Rust
// schema engine, which will not exist inside the compiled binary. The binary applies this
// script through the adapter's executeScript instead.
//
// And it writes src/store/derived-ddl.ts, the SAME DDL as a TypeScript constant: a compiled
// binary has no `prisma/init.sql` beside its code (`import.meta.url` resolves into the compiled
// filesystem, where the file is absent), so the DDL must travel inside the bundle. The two files
// are written from one string in one run; `createStore.test.ts` asserts they never drift.
//
// `--out-root <dir>` writes all of it (both prisma/ files, src/store/derived-ddl.ts and the
// generated client, which the schema places at ../src/store/generated) under <dir> instead of the
// package. The test uses it: `prisma generate` deletes and recreates every file of its output, so
// deriving in place during a vitest run pulled internal/class.ts out from under concurrent Bun
// children ("Cannot find module './internal/class'"; docs/sessions/2026-09-26-approvals-restart-flake.md).

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const repoRoot = path.resolve(pkgRoot, "../..");

/** The package, or the directory named by `--out-root`; anything else is refused, never guessed. */
function outRootFrom(argv) {
  if (argv.length === 0) return pkgRoot;
  if (argv.length === 2 && argv[0] === "--out-root" && argv[1] !== "") return path.resolve(argv[1]);
  throw new Error(`derive-sqlite-schema: usage: derive-sqlite-schema.mjs [--out-root <dir>], got: ${argv.join(" ")}`);
}

const outRoot = outRootFrom(process.argv.slice(2));
const CANONICAL = path.join(repoRoot, "apps/web/prisma/schema.prisma");
const OUT_SCHEMA = path.join(outRoot, "prisma/schema.sqlite.prisma");
const OUT_DDL = path.join(outRoot, "prisma/init.sql");
const OUT_DDL_MODULE = path.join(outRoot, "src/store/derived-ddl.ts");
const PRISMA_CLI = path.join(repoRoot, "node_modules/prisma/build/index.js");

const HEADER = [
  "// GENERATED FILE - DO NOT EDIT.",
  "// Produced by packages/trent-core/scripts/derive-sqlite-schema.mjs",
  "// Source of truth: apps/web/prisma/schema.prisma",
  "",
  "",
].join("\n");

const GENERATOR = [
  "generator client {",
  '  provider   = "prisma-client"',
  '  engineType = "client"',
  '  runtime    = "bun"',
  '  output     = "../src/store/generated"',
  "}",
].join("\n");

const DATASOURCE = [
  "datasource db {",
  '  provider = "sqlite"',
  '  url      = env("TRENT_SQLITE_URL")',
  "}",
].join("\n");

const BLOCK = (keyword) => new RegExp(`^${keyword}\\s+\\w+\\s*\\{[\\s\\S]*?^\\}`, "m");

function replaceBlock(source, keyword, replacement) {
  const re = BLOCK(keyword);
  if (!re.test(source)) {
    throw new Error(`derive-sqlite-schema: no ${keyword} block found in ${CANONICAL}`);
  }
  let seen = 0;
  const out = source.replace(new RegExp(re.source, "gm"), (match) => {
    seen += 1;
    if (seen > 1) {
      throw new Error(
        `derive-sqlite-schema: expected exactly one ${keyword} block, found ${seen}. ` +
          "The derivation is only safe for a single-datasource, single-generator schema.",
      );
    }
    return replacement;
  });
  return out;
}

function derive(canonicalSource) {
  let out = canonicalSource;
  out = replaceBlock(out, "generator", GENERATOR);
  out = replaceBlock(out, "datasource", DATASOURCE);
  out = out.replace(/\s+@db\.\w+(\([^)]*\))?/g, "");
  return HEADER + out.trimEnd() + "\n";
}

/**
 * `prisma migrate diff` emits Json defaults for sqlite as bare literals —
 * `"constraints" JSONB NOT NULL DEFAULT {}` — which sqlite rejects with
 * `unrecognized token: "{"`. Quote them. Prisma bug, upstream of us; verified against
 * 6.19.3. Recheck on upgrade: if the emitted DDL is already quoted this is a no-op.
 */
function fixJsonDefaults(ddl) {
  const fixed = ddl.replace(/(JSONB[^,\n]*DEFAULT )(\{\}|\[\])/g, "$1'$2'");
  if (/DEFAULT (\{|\[)/.test(fixed)) {
    throw new Error("derive-sqlite-schema: an unquoted JSON default survived the DDL rewrite");
  }
  return fixed;
}

/** The DDL as a TypeScript module, so the bundler embeds it in every artefact. */
function ddlModule(ddl) {
  return [
    "// GENERATED FILE - DO NOT EDIT.",
    "// Produced by packages/trent-core/scripts/derive-sqlite-schema.mjs, byte for byte the",
    "// contents of packages/trent-core/prisma/init.sql. The compiled binary has no file system",
    "// path to that file, so the DDL travels as this constant (see createStore.ts).",
    "",
    "/** The derived SQLite DDL that creates an empty Trent store. */",
    `export const DERIVED_DDL: string = ${JSON.stringify(ddl)};`,
    "",
  ].join("\n");
}

function main() {
  const canonical = readFileSync(CANONICAL, "utf8");
  const derived = derive(canonical);

  if (/@db\./.test(derived)) {
    throw new Error("derive-sqlite-schema: native @db. types survived the rewrite");
  }
  if (/directUrl/.test(derived)) {
    throw new Error("derive-sqlite-schema: directUrl survived the rewrite");
  }

  mkdirSync(path.dirname(OUT_SCHEMA), { recursive: true });
  mkdirSync(path.dirname(OUT_DDL_MODULE), { recursive: true });
  writeFileSync(OUT_SCHEMA, derived, "utf8");

  const ddl = execFileSync(
    process.execPath,
    [
      PRISMA_CLI,
      "migrate",
      "diff",
      "--from-empty",
      "--to-schema-datamodel",
      OUT_SCHEMA,
      "--script",
    ],
    { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  const fixedDdl = fixJsonDefaults(ddl);
  writeFileSync(OUT_DDL, fixedDdl, "utf8");
  writeFileSync(OUT_DDL_MODULE, ddlModule(fixedDdl), "utf8");

  // Generate the client from the derived schema in the same breath, so the schema, the DDL
  // and the generated types can never be out of step with one another either.
  execFileSync(process.execPath, [PRISMA_CLI, "generate", "--schema", OUT_SCHEMA], {
    cwd: repoRoot,
    stdio: ["ignore", "ignore", "inherit"],
  });

  const models = (derived.match(/^model \w+ \{/gm) ?? []).length;
  const tables = (ddl.match(/^CREATE TABLE /gm) ?? []).length;
  process.stdout.write(
    `derived ${path.relative(repoRoot, OUT_SCHEMA)} (${models} models)\n` +
      `derived ${path.relative(repoRoot, OUT_DDL)} (${tables} tables)\n` +
      `derived ${path.relative(repoRoot, OUT_DDL_MODULE)} (embedded copy)\n`,
  );
}

main();
