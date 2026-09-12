#!/usr/bin/env node
/**
 * Stages everything the desktop bundle SHIPS, before `tauri build` runs.
 * Wired as `build.beforeBuildCommand` in src-tauri/tauri.conf.json.
 *
 * Two artefacts, and neither of them is a from-scratch UI:
 *
 *   1. src-tauri/binaries/bun-<target-triple>   the vendored Bun RUNTIME
 *   2. src-tauri/resources/server/              the Next.js `.next/standalone` tree
 *
 * Why a runtime and not a compiled binary — measured, see
 * 01_discovery/output/spike-serve-results.md:
 *   `bun build --compile` on the Next server fails with 20 unresolved specifiers.
 *   Forcing it through with `--external` yields a 169 MB binary that boots, serves
 *   an empty shell and 404s its own chunks. `bun run .next/standalone/server.js`
 *   reaches ready in 301 ms and serves `/` and `/api/health` with 200.
 * So: Bun ships as an interpreter, the app ships as JavaScript. The claim this
 * supports is "no external dependencies to install", NOT "a single binary".
 *
 * Why the Next build is invoked as `next build apps/web` FROM THE REPO ROOT:
 *   apps/web/next.config.ts sets `outputFileTracingRoot: process.cwd()`, which in
 *   this hoisted monorepo resolves to apps/web and emits a standalone tree with NO
 *   node_modules (defect 3 in AGENTS.md, task 6.1 of the milestone). apps/web is
 *   read-only to this workspace and a test asserts against that config file, so it
 *   is not edited here. Running the build with the repo root as cwd makes
 *   `process.cwd()` the repo root — the correct tracing root — WITHOUT touching a
 *   single byte of apps/web. Measured: 133 MB tree, node_modules present,
 *   apps/web/node_modules left clean.
 *   `NEXT_PRIVATE_STANDALONE=1` is Next's documented env override for
 *   `output: "standalone"`, used for the same reason.
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  chmodSync,
  mkdirSync,
  rmSync,
  statSync,
  readdirSync,
  copyFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = resolve(HERE, "..");
const REPO = resolve(DESKTOP, "../..");
const SRC_TAURI = join(DESKTOP, "src-tauri");
const BIN_DIR = join(SRC_TAURI, "binaries");
const RES_DIR = join(SRC_TAURI, "resources", "server");
const STANDALONE = join(REPO, "apps/web/.next/standalone");

const log = (...a) => console.log("[prepare-resources]", ...a);

/** The Rust host triple, which is the suffix `bundle.externalBin` demands. */
function hostTriple() {
  if (process.env.TRENT_TARGET_TRIPLE) return process.env.TRENT_TARGET_TRIPLE;
  const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const m = out.match(/^host:\s*(\S+)$/m);
  if (!m) throw new Error("could not read host triple from `rustc -vV`");
  return m[1];
}

/** Locate a Bun runtime to vendor. Never downloads: the machine must already have one. */
function findBun() {
  const candidates = [
    process.env.TRENT_BUN_BIN,
    join(homedir(), ".bun/bin/bun"),
    "/opt/homebrew/bin/bun",
    "/usr/local/bin/bun",
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  try {
    return execFileSync("sh", ["-lc", "command -v bun"], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

function vendorBun() {
  const triple = hostTriple();
  const dest = join(BIN_DIR, `bun-${triple}`);
  mkdirSync(BIN_DIR, { recursive: true });
  const src = findBun();
  if (!src) {
    throw new Error(
      "No Bun runtime found to vendor. Install Bun (https://bun.sh) or set TRENT_BUN_BIN " +
        "to an absolute path. The bundle ships Bun as its server runtime; there is no fallback."
    );
  }
  if (existsSync(dest) && statSync(dest).size === statSync(src).size) {
    log(`bun already vendored: ${dest} (${(statSync(dest).size / 1e6).toFixed(1)} MB)`);
  } else {
    copyFileSync(src, dest);
    log(`vendored bun: ${src} -> ${dest} (${(statSync(dest).size / 1e6).toFixed(1)} MB)`);
  }
  chmodSync(dest, 0o755);
  return dest;
}

function buildWeb() {
  if (process.env.TRENT_DESKTOP_SKIP_WEB_BUILD === "1" && existsSync(join(STANDALONE, "apps/web/server.js"))) {
    log("TRENT_DESKTOP_SKIP_WEB_BUILD=1 and a standalone tree exists — reusing it.");
    return;
  }
  log("building apps/web standalone (cwd = repo root, so outputFileTracingRoot resolves correctly)");
  execFileSync(process.execPath, [join(REPO, "node_modules/next/dist/bin/next"), "build", "apps/web"], {
    cwd: REPO,
    stdio: "inherit",
    env: { ...process.env, NEXT_PRIVATE_STANDALONE: "1" },
  });
}

function stageServer() {
  const entry = join(STANDALONE, "apps/web/server.js");
  if (!existsSync(entry)) {
    throw new Error(
      `standalone build produced no server entry at ${entry}. ` +
        "Re-run without TRENT_DESKTOP_SKIP_WEB_BUILD, or inspect the Next build output."
    );
  }
  rmSync(RES_DIR, { recursive: true, force: true });
  mkdirSync(RES_DIR, { recursive: true });
  cpSync(STANDALONE, RES_DIR, { recursive: true, dereference: true });

  // `next build` deliberately leaves these two out of the standalone tree —
  // the docs require copying them in by hand, or the app serves an empty shell.
  const staticSrc = join(REPO, "apps/web/.next/static");
  const staticDest = join(RES_DIR, "apps/web/.next/static");
  if (existsSync(staticSrc)) {
    mkdirSync(dirname(staticDest), { recursive: true });
    cpSync(staticSrc, staticDest, { recursive: true, dereference: true });
  }
  const publicSrc = join(REPO, "apps/web/public");
  if (existsSync(publicSrc)) {
    cpSync(publicSrc, join(RES_DIR, "apps/web/public"), { recursive: true, dereference: true });
  }

  let bytes = 0;
  let files = 0;
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        files += 1;
        bytes += statSync(p).size;
      }
    }
  };
  walk(RES_DIR);
  log(`staged server tree: ${RES_DIR} (${files} files, ${(bytes / 1e6).toFixed(0)} MB)`);
  log(`entry: server/apps/web/server.js  static: ${existsSync(staticDest) ? "present" : "MISSING"}`);
}

vendorBun();
buildWeb();
stageServer();
log("ready");
