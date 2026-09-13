/**
 * `trent web --start`: the CLI running the same thing the desktop sidecar runs.
 *
 * The desktop (apps/desktop/src-tauri/src/server.rs) executes the Next.js `.next/standalone` tree
 * on a loopback port with a per-install AUTH_SECRET and the standalone environment contract from
 * packages/trent-core/src/runtime/env.ts. This module does exactly that from the CLI, from either
 * a clone (`apps/web/.next/standalone`) or the resources a `trent desktop install` laid down.
 *
 * The AUTH_SECRET derivation matches apps/desktop/src-tauri/src/auth_secret.rs: 32 random bytes,
 * hex-encoded, written atomically with mode 0600, never regenerated while a value exists, never
 * printed. The desktop keeps its own copy under `<home>/desktop/auth-secret`; the CLI keeps one per
 * profile at `<profileDir>/auth_secret`.
 *
 * Nothing here prints for itself. The handler in groups/servers.ts returns data; this returns facts.
 */

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { EXIT, TrentError } from "@trent/core/errors/index.js";
import { readDesktopManifest } from "@trent/core/updater/index.js";
import type { CommandContext, WebChild, WebSpawnOptions } from "./context.js";

export const AUTH_SECRET_FILE = "auth_secret";
const SECRET_BYTES = 32;
const READY_TIMEOUT_MS = 30_000;
const READY_INTERVAL_MS = 250;

/** The command a clone needs to run before `trent web --start` can serve anything. */
export const BUILD_HINT = "cd apps/web && npm run build";

export type WebSource = "clone" | "desktop";

export interface WebTarget {
  source: WebSource;
  /** The `server.js` to execute. */
  entry: string;
  /** `apps/web` in a clone; the bundle root for a desktop install. */
  appDir: string;
}

function fail(operation: string, message: string, target?: string): TrentError {
  return new TrentError({ code: EXIT.CONFIG, operation, message, ...(target === undefined ? {} : { target }) });
}

// ------------------------------------------------------------------ AUTH_SECRET

function chmodQuietly(target: string, mode: number): void {
  if (process.platform === "win32") return;
  if ((fs.statSync(target).mode & 0o777) !== mode) fs.chmodSync(target, mode);
}

/** Load `dir/auth_secret`, creating it privately on first use. The value is only ever returned. */
export function loadOrCreateAuthSecret(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, AUTH_SECRET_FILE);
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing !== "") {
      chmodQuietly(file, 0o600);
      return existing;
    }
  }
  const secret = crypto.randomBytes(SECRET_BYTES).toString("hex");
  const tmp = path.join(dir, `.${AUTH_SECRET_FILE}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, `${secret}\n`, { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
  chmodQuietly(file, 0o600);
  return secret;
}

// ------------------------------------------------------------------ locating the server

/** Walk up from `start` to the first directory holding `apps/web/package.json`. */
export function findRepoRoot(start: string): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, "apps/web/package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Both layouts `next build` produces: tracing root = apps/web (flat) or = repo root (nested). */
export function standaloneEntry(appDir: string): string | undefined {
  const candidates = [
    path.join(appDir, ".next/standalone/server.js"),
    path.join(appDir, ".next/standalone/apps/web/server.js"),
  ];
  return candidates.find((c) => fs.existsSync(c));
}

/** The `server/apps/web/server.js` resource inside a bundle `trent desktop install` wrote. */
function desktopEntry(home: string): { entry: string; bundle: string } | undefined {
  const manifest = readDesktopManifest(home);
  if (manifest === undefined || manifest.uninstalledAt !== undefined) return undefined;
  const bundle = manifest.paths[0];
  if (bundle === undefined) return undefined;
  const suffixes = [
    "Contents/Resources/server/apps/web/server.js", // macOS .app
    "resources/server/apps/web/server.js", // Windows install dir, Linux unpacked
    "server/apps/web/server.js",
  ];
  for (const suffix of suffixes) {
    const candidate = path.join(bundle, suffix);
    if (fs.existsSync(candidate)) return { entry: candidate, bundle };
  }
  return undefined;
}

export interface LocateOptions {
  repoRoot: string | undefined;
  home: string;
}

export type LocateResult =
  | { kind: "found"; target: WebTarget }
  | { kind: "unbuilt"; appDir: string }
  | { kind: "absent"; tried: string[] };

/** A clone wins over an install: the developer running from a checkout wants that checkout. */
export function locateWebServer(options: LocateOptions): LocateResult {
  const root = options.repoRoot === undefined ? undefined : findRepoRoot(options.repoRoot);
  if (root !== undefined) {
    const appDir = path.join(root, "apps/web");
    const entry = standaloneEntry(appDir);
    if (entry !== undefined) return { kind: "found", target: { source: "clone", entry, appDir } };
    return { kind: "unbuilt", appDir };
  }
  const desktop = desktopEntry(options.home);
  if (desktop !== undefined) {
    return { kind: "found", target: { source: "desktop", entry: desktop.entry, appDir: desktop.bundle } };
  }
  return {
    kind: "absent",
    tried: [path.join(options.repoRoot ?? process.cwd(), "apps/web/package.json"), path.join(options.home, "desktop/manifest.json")],
  };
}

// ------------------------------------------------------------------ runtime

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * What executes `server.js`. A clone runs it on the Node that runs the CLI. A desktop install ships
 * its own Bun sidecar next to the app binary, and that is what the desktop itself uses. Under a
 * compiled `trent` binary `process.execPath` is `trent`, so fall back to a Bun on disk.
 */
export function resolveRuntime(target: WebTarget): string {
  if (target.source === "desktop") {
    const contents = target.entry.split(path.sep).lastIndexOf("Contents");
    const bundled =
      contents >= 0
        ? path.join(...target.entry.split(path.sep).slice(0, contents + 1), "MacOS", "bun")
        : path.join(target.appDir, process.platform === "win32" ? "bun.exe" : "bun");
    if (isFile(bundled)) return bundled;
  }
  if (process.versions.bun === undefined) return process.execPath;
  const candidates = [
    process.env.TRENT_BUN_BIN,
    path.join(os.homedir(), ".bun/bin/bun"),
    "/opt/homebrew/bin/bun",
    "/usr/local/bin/bun",
  ].filter((c): c is string => typeof c === "string" && c !== "");
  return candidates.find(isFile) ?? "bun";
}

// ------------------------------------------------------------------ static assets

/**
 * `next build` leaves `.next/static` and `public` out of the standalone tree; the desktop's
 * prepare-resources copies them in. From a clone, link them so the page is not an empty shell.
 * Only ever writes inside `.next/standalone`, which is build output.
 */
export function ensureStaticAssets(target: WebTarget): void {
  if (target.source !== "clone") return;
  const entryDir = path.dirname(target.entry);
  const pairs: Array<[string, string]> = [
    [path.join(target.appDir, ".next/static"), path.join(entryDir, ".next/static")],
    [path.join(target.appDir, "public"), path.join(entryDir, "public")],
  ];
  for (const [src, dest] of pairs) {
    if (!fs.existsSync(src) || fs.existsSync(dest)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.symlinkSync(src, dest, "dir");
  }
}

// ------------------------------------------------------------------ ports and readiness

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function probe(url: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 2_000 }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.once("error", () => resolve(undefined));
    req.once("timeout", () => {
      req.destroy();
      resolve(undefined);
    });
  });
}

/** Poll `url` until it answers 2xx or 3xx. Resolves with the elapsed milliseconds. */
export async function waitForReady(
  url: string,
  options: { timeoutMs?: number; intervalMs?: number; isAlive?: () => boolean } = {},
): Promise<number> {
  const timeoutMs = options.timeoutMs ?? READY_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? READY_INTERVAL_MS;
  const started = Date.now();
  for (;;) {
    if (options.isAlive !== undefined && !options.isAlive()) {
      throw fail("web.start", "the web server exited before it became ready", url);
    }
    const status = await probe(url);
    if (status !== undefined && status >= 200 && status < 400) return Date.now() - started;
    if (Date.now() - started >= timeoutMs) {
      throw fail("web.start", `the web server did not become ready within ${String(Math.round(timeoutMs / 1000))}s`, url);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ------------------------------------------------------------------ environment

/** The child's environment: the desktop's, plus the standalone contract. No value is ever logged. */
export function childEnv(port: number, authSecret: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ["REDIS_URL", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "TRENT_EVAL_SYNC_QUEUE"]) {
    delete env[key];
  }
  env.HOSTNAME = "127.0.0.1";
  env.PORT = String(port);
  env.NODE_ENV = "production";
  env.AUTH_SECRET = authSecret;
  env.TRENT_QUEUE_FALLBACK = "disabled";
  env.SKILL_INJECTION_ENABLED = "1";
  env.REDIS_URL = "";
  return env;
}

// ------------------------------------------------------------------ opening a browser

/** The URL travels as an argument, never through a shell string. */
export function openBrowser(url: string): void {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.once("error", () => undefined);
  child.unref();
}

// ------------------------------------------------------------------ the build

/**
 * `--build`: the same invocation apps/desktop/scripts/prepare-resources.mjs uses. It runs
 * `next build apps/web` FROM THE REPO ROOT so `outputFileTracingRoot` (= `process.cwd()`) covers the
 * hoisted node_modules; built from inside apps/web the tree ships without them.
 */
export function buildStandalone(ctx: CommandContext, appDir: string): Promise<void> {
  const repoRoot = path.resolve(appDir, "../..");
  const nextBin = path.join(repoRoot, "node_modules/next/dist/bin/next");
  const runtime = process.versions.bun === undefined ? process.execPath : "node";
  ctx.err(`building the standalone web app: ${runtime} ${nextBin} build apps/web (cwd ${repoRoot})`);
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(runtime, [nextBin, "build", "apps/web"], {
      cwd: repoRoot,
      env: { ...process.env, NEXT_PRIVATE_STANDALONE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const forward = (chunk: Buffer): void => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) if (line.trim() !== "") ctx.err(`  ${line}`);
    };
    child.stdout?.on("data", forward);
    child.stderr?.on("data", forward);
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        ctx.err(`build finished in ${String(Math.round((Date.now() - started) / 1000))}s`);
        resolve();
      } else {
        reject(fail("web.build", `next build exited with code ${String(code)}`, appDir));
      }
    });
  });
}

// ------------------------------------------------------------------ the start

export interface StartOptions {
  port: number;
  build: boolean;
  open: boolean;
}

export interface StartResult {
  port: number;
  url: string;
  pid: number;
  source: WebSource;
  entry: string;
  readyMs: number;
}

/** Keep the child tied to this process: Ctrl+C (exit 130 in index.ts) and SIGTERM take it down too. */
function attachLifecycle(child: WebChild, ctx: CommandContext): void {
  let gone = false;
  child.once("exit", (code, signal) => {
    gone = true;
    if (code !== 0) ctx.err(`web server exited (${signal ?? `code ${String(code)}`})`);
  });
  const stop = (): void => {
    if (!gone) child.kill("SIGTERM");
  };
  process.once("exit", stop);
  for (const signal of ["SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => {
      stop();
      process.exit(EXIT.INTERRUPT);
    });
  }
}

export async function startWebServer(ctx: CommandContext, target: WebTarget, options: StartOptions): Promise<StartResult> {
  const port = options.port === 0 ? await freePort() : options.port;
  const secret = loadOrCreateAuthSecret(ctx.config().getProfileDir());
  ensureStaticAssets(target);
  const runtime = resolveRuntime(target);
  const spawnOptions: WebSpawnOptions = { cwd: path.dirname(target.entry), env: childEnv(port, secret) };
  const spawner =
    ctx.overrides.webSpawn ??
    ((command, args, o) => spawn(command, [...args], { cwd: o.cwd, env: o.env, stdio: ["ignore", "inherit", "inherit"] }));
  const child = spawner(runtime, [target.entry], spawnOptions);

  let alive = true;
  child.once("exit", () => {
    alive = false;
  });
  const url = `http://127.0.0.1:${String(port)}`;
  let readyMs: number;
  try {
    readyMs = await waitForReady(`${url}/`, { isAlive: () => alive });
  } catch (error) {
    if (alive) child.kill("SIGTERM");
    throw error;
  }
  attachLifecycle(child, ctx);
  if (options.open) (ctx.overrides.webOpen ?? openBrowser)(url);
  return { port, url, pid: child.pid ?? 0, source: target.source, entry: target.entry, readyMs };
}
