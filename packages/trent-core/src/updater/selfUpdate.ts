/**
 * `trent update`: check, plan, apply, rollback, prune. Every apply, successful or not, leaves a
 * machine-readable receipt under `<home>/logs/update_receipts/`, so "what happened to my binary"
 * has an answer that does not depend on scrollback.
 *
 * On-disk layout is the installer's, and the contract is `scripts/installer/LAYOUT.md`:
 *
 *   <home>/bin/trent            launcher (POSIX sh; trent.cmd on Windows). Never rewritten by an
 *                               update; only repaired when missing or replaced by a raw binary.
 *   <home>/current              one line naming the active version. The ONLY switch.
 *   <home>/versions/<v>/trent   one directory per installed version. Nothing is deleted by an
 *                               update; the previous directory IS the rollback target.
 *   <home>/staging/             private (0700) scratch; empty after a successful run.
 *
 * Apply = verify, rename into `versions/<new>/`, prove `--version`, atomically rewrite `current`.
 * Rollback = rewrite `current` with the previous name. Prune is separate and explicit.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { EXIT, TrentError } from "../errors/index.js";
import { installAtomically } from "./install.js";
import { describeSource, fetchArtifact, releaseDownloadUrl, resolveLatest, type Channel, type ReleaseOptions } from "./release.js";
import { verifyArtifact } from "./verify.js";
import { assertValidVersion, compareVersions } from "./version.js";

const execFileAsync = promisify(execFile);

export interface UpdaterEnv {
  /** The Trent home, normally `~/.trent`. */
  home: string;
  /** Version of the running CLI, used when `<home>/current` is absent. */
  currentVersion: string;
  /** Release asset name for this platform, e.g. `trent-darwin-arm64`. */
  asset: string;
  release: ReleaseOptions;
  /** Minisign public key text; defaults to the embedded release key. */
  publicKey?: string;
  /** Override the launcher path; defaults to `<home>/bin/trent` (`trent.cmd` on Windows). */
  targetPath?: string;
  /** Override the platform (tests); defaults to `process.platform`. */
  platform?: NodeJS.Platform;
}

export interface UpdateCheck {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  asset: string;
  source: string;
}

export interface UpdatePlan {
  action: "install" | "up-to-date";
  fromVersion: string;
  toVersion: string;
  asset: string;
  url: string;
  /** Where the verified binary will land: `<home>/versions/<toVersion>/trent`. */
  targetPath: string;
  force: boolean;
  source: string;
}

export interface UpdateReceipt {
  ok: boolean;
  action: "install" | "rollback" | "prune";
  fromVersion: string;
  toVersion: string;
  asset: string;
  sha256?: string;
  /** The binary now named by `current`: `<home>/versions/<toVersion>/trent`. */
  installedPath: string;
  /** The version `rollback` will switch back to, and where its binary lives. */
  previousVersion?: string;
  previousPath?: string;
  /** The launcher this update runs through. Updates never rewrite it unless it was broken. */
  launcherPath: string;
  /** Present when the launcher had to be written (missing, or a legacy raw-binary overwrite). */
  launcherRepaired?: string;
  timestamp: string;
  error?: string;
  receiptPath: string;
}

export interface TrentLayout {
  home: string;
  binDir: string;
  launcherPath: string;
  currentFile: string;
  versionsDir: string;
  stagingDir: string;
  binaryName: string;
}

export function platformAssetName(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  const os = platform === "win32" ? "windows" : platform;
  return `trent-${os}-${arch}${platform === "win32" ? ".exe" : ""}`;
}

function platformOf(env: UpdaterEnv): NodeJS.Platform {
  return env.platform ?? process.platform;
}

export function layoutOf(env: UpdaterEnv): TrentLayout {
  const win = platformOf(env) === "win32";
  return {
    home: env.home,
    binDir: path.join(env.home, "bin"),
    launcherPath: env.targetPath ?? path.join(env.home, "bin", win ? "trent.cmd" : "trent"),
    currentFile: path.join(env.home, "current"),
    versionsDir: path.join(env.home, "versions"),
    stagingDir: path.join(env.home, "staging"),
    binaryName: win ? "trent.exe" : "trent",
  };
}

/** The launcher on PATH: `<home>/bin/trent`. What the user runs; never what an update replaces. */
export function targetBinaryPath(env: UpdaterEnv): string {
  return layoutOf(env).launcherPath;
}

/** `<home>/versions/<version>/trent`: the binary an update writes and `current` names. */
export function versionBinaryPath(env: UpdaterEnv, version: string): string {
  const l = layoutOf(env);
  return path.join(l.versionsDir, assertValidVersion(version, "updater.layout"), l.binaryName);
}

/**
 * The launcher text, byte-for-byte what `scripts/install.sh` writes. It reads `current` at run
 * time and execs `versions/<v>/trent`, so switching versions never touches this file.
 */
export function launcherText(home: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    return [
      "@echo off",
      `rem Trent Fleet launcher, written by install.sh. Runs the version named in ${path.join(home, "current")}.`,
      `set "TRENT_HOME=${home}"`,
      'set /p v=<"%TRENT_HOME%\\current" 2>nul',
      'if "%v%"=="" goto missing',
      'if not exist "%TRENT_HOME%\\versions\\%v%\\trent.exe" goto missing',
      '"%TRENT_HOME%\\versions\\%v%\\trent.exe" %*',
      "exit /b %errorlevel%",
      ":missing",
      "echo trent: no installed version recorded in %TRENT_HOME%\\current; re-run the installer 1>&2",
      "exit /b 127",
      "",
    ].join("\r\n");
  }
  return [
    "#!/bin/sh",
    `# Trent Fleet launcher, written by install.sh. Runs the version named in ${path.join(home, "current")}.`,
    `TRENT_HOME="${home}"`,
    'v=$(head -n 1 "$TRENT_HOME/current" 2>/dev/null)',
    '[ -n "$v" ] && [ -x "$TRENT_HOME/versions/$v/trent" ] || {',
    '  echo "trent: no installed version recorded in $TRENT_HOME/current; re-run the installer" >&2; exit 127; }',
    'exec "$TRENT_HOME/versions/$v/trent" "$@"',
    "",
  ].join("\n");
}

const LAUNCHER_MARK = "Trent Fleet launcher";

/** True when `file` is a launcher (ours or the installer's): a small text file carrying the mark. */
export function isLauncher(file: string): boolean {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 4096) return false;
    return fs.readFileSync(file, "utf8").includes(LAUNCHER_MARK);
  } catch {
    return false;
  }
}

export function installedVersion(env: UpdaterEnv): string {
  const file = layoutOf(env).currentFile;
  if (fs.existsSync(file)) {
    const recorded = fs.readFileSync(file, "utf8").split(/\r?\n/, 1)[0]?.trim() ?? "";
    if (recorded.length > 0) return assertValidVersion(recorded, "updater.current");
  }
  return assertValidVersion(env.currentVersion, "updater.current");
}

export function receiptsDir(env: UpdaterEnv): string {
  return path.join(env.home, "logs", "update_receipts");
}

function writeReceipt(env: UpdaterEnv, receipt: Omit<UpdateReceipt, "receiptPath">): UpdateReceipt {
  const dir = receiptsDir(env);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = receipt.timestamp.replace(/[:.]/g, "-");
  const file = path.join(dir, `${stamp}-${receipt.action}-${receipt.fromVersion}-to-${receipt.toVersion}.json`);
  const full: UpdateReceipt = { ...receipt, receiptPath: file };
  fs.writeFileSync(file, `${JSON.stringify(full, null, 2)}\n`, { mode: 0o600 });
  return full;
}

/** Step 4 of LAYOUT.md: write `current.tmp`, then rename over `current`. The only switch. */
export function writeCurrent(env: UpdaterEnv, version: string): void {
  const l = layoutOf(env);
  fs.mkdirSync(l.home, { recursive: true });
  const tmp = `${l.currentFile}.tmp`;
  fs.writeFileSync(tmp, `${assertValidVersion(version, "updater.current")}\n`, { mode: 0o644 });
  const fd = fs.openSync(tmp, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, l.currentFile);
}

function utcStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Move `versions/<v>` aside the way the installer does, instead of deleting it. */
function quarantine(dir: string): string {
  const aside = `${dir}.broken-${utcStamp()}`;
  fs.renameSync(dir, aside);
  return aside;
}

export async function checkUpdate(env: UpdaterEnv, channel: Channel, signal?: AbortSignal): Promise<UpdateCheck> {
  const current = installedVersion(env);
  const latest = await resolveLatest(channel, env.release, signal);
  return {
    currentVersion: current,
    latestVersion: latest.version,
    updateAvailable: compareVersions(latest.version, current) > 0,
    asset: env.asset,
    source: describeSource(env.release),
  };
}

export interface PlanOptions {
  channel?: Channel;
  /** Pin a version instead of resolving the channel's latest. */
  version?: string;
  force?: boolean;
  signal?: AbortSignal;
}

/** Decide what apply would do. Refuses to move backwards unless forced. */
export async function planUpdate(env: UpdaterEnv, options: PlanOptions = {}): Promise<UpdatePlan> {
  const fromVersion = installedVersion(env);
  const toVersion =
    options.version !== undefined
      ? assertValidVersion(options.version, "updater.plan")
      : (await resolveLatest(options.channel ?? "stable", env.release, options.signal)).version;
  const force = options.force === true;
  const order = compareVersions(toVersion, fromVersion);
  if (order < 0 && !force) {
    throw new TrentError({
      code: EXIT.USAGE,
      operation: "updater.plan",
      message: `refusing to downgrade from ${fromVersion} to ${toVersion}; pass --force to move backwards`,
      target: toVersion,
    });
  }
  return {
    action: order === 0 && !force ? "up-to-date" : "install",
    fromVersion,
    toVersion,
    asset: env.asset,
    url: releaseDownloadUrl(env.asset, toVersion, env.release).href,
    targetPath: versionBinaryPath(env, toVersion),
    force,
    source: describeSource(env.release),
  };
}

async function reportedVersion(binary: string): Promise<string> {
  const { stdout } = await execFileAsync(binary, ["--version"], { timeout: 30_000 });
  return stdout.trim();
}

/**
 * Make sure `<home>` has the installer's shape before an update relies on it. Two repairs, both
 * reported so the receipt says what changed beyond the new version:
 *
 *  - `bin/trent` is a raw binary (the pre-layout updater overwrote the launcher): run it to learn
 *    its version, move it to `versions/<v>/trent`, record `current`, write the launcher.
 *  - `bin/trent` is missing: write the launcher.
 */
async function ensureLayout(env: UpdaterEnv): Promise<string | undefined> {
  const l = layoutOf(env);
  fs.mkdirSync(l.binDir, { recursive: true });
  fs.mkdirSync(l.versionsDir, { recursive: true });
  fs.mkdirSync(l.stagingDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(l.stagingDir, 0o700);

  let repaired: string | undefined;
  let stat: fs.Stats | undefined;
  try {
    stat = fs.lstatSync(l.launcherPath);
  } catch {
    stat = undefined;
  }
  if (stat !== undefined && !isLauncher(l.launcherPath)) {
    if (stat.isSymbolicLink()) {
      // The layout says the launcher is never a symlink; whatever it pointed at is not ours to move.
      fs.rmSync(l.launcherPath, { force: true });
      repaired = `replaced symlink at ${l.launcherPath} with the launcher`;
    } else {
      const version = await reportedVersion(l.launcherPath)
        .then((v) => assertValidVersion(v, "updater.migrate"))
        .catch(() => installedVersion(env));
      const dest = versionBinaryPath(env, version);
      if (fs.existsSync(path.dirname(dest))) quarantine(path.dirname(dest));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(l.launcherPath, dest);
      fs.chmodSync(dest, 0o755);
      writeCurrent(env, version);
      repaired = `migrated legacy layout: moved raw binary ${l.launcherPath} to ${dest} and wrote the launcher`;
    }
  } else if (stat === undefined) {
    repaired = `launcher was missing at ${l.launcherPath}; wrote it`;
  }
  if (repaired !== undefined) {
    const tmp = path.join(l.binDir, `.${path.basename(l.launcherPath)}.launcher-${process.pid}`);
    fs.writeFileSync(tmp, launcherText(l.home, platformOf(env)), { mode: 0o755 });
    fs.renameSync(tmp, l.launcherPath);
  }
  return repaired;
}

/** Download, verify, rename into `versions/<new>/`, prove the binary runs, repoint `current`, record the receipt. */
export async function applyUpdate(env: UpdaterEnv, plan: UpdatePlan, signal?: AbortSignal): Promise<UpdateReceipt> {
  const timestamp = new Date().toISOString();
  const l = layoutOf(env);
  const previousPath = versionBinaryPath(env, plan.fromVersion);
  const base = {
    action: "install" as const,
    fromVersion: plan.fromVersion,
    toVersion: plan.toVersion,
    asset: plan.asset,
    installedPath: plan.targetPath,
    launcherPath: l.launcherPath,
    timestamp,
  };
  if (plan.action === "up-to-date") return writeReceipt(env, { ...base, ok: true });

  const dirs: string[] = [];
  let launcherRepaired: string | undefined;
  try {
    launcherRepaired = await ensureLayout(env);
    const repairNote = launcherRepaired === undefined ? {} : { launcherRepaired };

    const artifact = await fetchArtifact(plan.asset, plan.toVersion, signal, env.release);
    dirs.push(artifact.dir);
    const sums = await fetchArtifact("SHA256SUMS", plan.toVersion, signal, env.release);
    dirs.push(sums.dir);
    const sig = await fetchArtifact("SHA256SUMS.minisig", plan.toVersion, signal, env.release);
    dirs.push(sig.dir);

    const verified = await verifyArtifact(artifact.path, sums.path, sig.path, env.publicKey === undefined ? {} : { publicKey: env.publicKey });

    // Into private staging under <home> (same filesystem as versions/), then one atomic rename.
    const staged = path.join(l.stagingDir, `${plan.asset}.verified`);
    fs.rmSync(staged, { force: true });
    fs.copyFileSync(verified.path, staged, fs.constants.COPYFILE_EXCL);
    fs.rmSync(verified.path, { force: true });
    const versionDir = path.dirname(plan.targetPath);
    if (fs.existsSync(versionDir)) quarantine(versionDir);
    installAtomically(staged, plan.targetPath, 0o755);
    fs.chmodSync(versionDir, 0o755);

    const reported = await reportedVersion(plan.targetPath).catch((error: unknown) => {
      quarantine(versionDir);
      throw new TrentError({ code: EXIT.CONFIG, operation: "updater.apply", message: `installed binary failed to run --version: ${error instanceof Error ? error.message : String(error)}; current still names ${plan.fromVersion}`, target: plan.targetPath });
    });
    if (reported !== plan.toVersion) {
      const aside = quarantine(versionDir);
      throw new TrentError({
        code: EXIT.CONFIG,
        operation: "updater.apply",
        message: `installed binary reports version '${reported}', expected '${plan.toVersion}'; moved it to ${aside}, current still names ${plan.fromVersion}`,
        target: plan.targetPath,
      });
    }
    writeCurrent(env, plan.toVersion);
    return writeReceipt(env, {
      ...base,
      ok: true,
      sha256: verified.sha256,
      ...(fs.existsSync(previousPath) ? { previousVersion: plan.fromVersion, previousPath } : {}),
      ...repairNote,
    });
  } catch (error) {
    const receipt = writeReceipt(env, {
      ...base,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      ...(launcherRepaired === undefined ? {} : { launcherRepaired }),
    });
    if (error instanceof TrentError) {
      throw new TrentError({ code: error.code, operation: error.operation, message: error.message, context: { receiptPath: receipt.receiptPath } });
    }
    throw error;
  } finally {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    if (fs.existsSync(l.stagingDir)) for (const f of fs.readdirSync(l.stagingDir)) fs.rmSync(path.join(l.stagingDir, f), { recursive: true, force: true });
  }
}

export interface RollbackResult {
  restoredPath: string;
  restoredVersion: string;
  receiptPath: string;
}

/** The version the last successful switch moved away from, if it differs from `current`. */
function previousVersionOf(env: UpdaterEnv): string | undefined {
  const current = installedVersion(env);
  const last = lastSuccessfulSwitch(env);
  if (last === undefined) return undefined;
  const candidate = last.action === "install" ? (last.previousVersion ?? last.fromVersion) : last.fromVersion;
  return candidate === current ? undefined : candidate;
}

/**
 * Repoint `current` at the previous version. Its directory is still on disk (updates delete
 * nothing), so this is one atomic write. Refused, naming the directory, if it has been pruned.
 */
export async function rollbackUpdate(env: UpdaterEnv): Promise<RollbackResult> {
  const l = layoutOf(env);
  const current = installedVersion(env);
  const previous = previousVersionOf(env);
  if (previous === undefined) {
    throw new TrentError({ code: EXIT.CONFIG, operation: "updater.rollback", message: "no previous version to roll back to; no successful update is recorded", target: receiptsDir(env) });
  }
  const restoredPath = versionBinaryPath(env, previous);
  const dir = path.dirname(restoredPath);
  if (!fs.existsSync(restoredPath)) {
    throw new TrentError({
      code: EXIT.CONFIG,
      operation: "updater.rollback",
      message: `cannot roll back to ${previous}: ${dir} is missing (pruned or deleted); reinstall it with trent update --to ${previous} --force`,
      target: dir,
    });
  }
  writeCurrent(env, previous);
  const receipt = writeReceipt(env, {
    ok: true,
    action: "rollback",
    fromVersion: current,
    toVersion: previous,
    asset: env.asset,
    installedPath: restoredPath,
    previousVersion: current,
    previousPath: versionBinaryPath(env, current),
    launcherPath: l.launcherPath,
    timestamp: new Date().toISOString(),
  });
  return { restoredPath, restoredVersion: previous, receiptPath: receipt.receiptPath };
}

export interface PruneVersionsResult {
  /** Version names kept: `current` and, when present, the one rollback would restore. */
  kept: string[];
  /** Absolute paths removed from `versions/`. */
  removed: string[];
  receiptPath: string;
}

/**
 * Remove every `versions/*` directory except `current` and the immediately previous version.
 * Explicit, never a side effect of an update; the result names exactly what went.
 */
export function pruneVersions(env: UpdaterEnv): PruneVersionsResult {
  const l = layoutOf(env);
  const current = installedVersion(env);
  const previous = previousVersionOf(env);
  const keep = new Set([current, ...(previous === undefined ? [] : [previous])]);
  const removed: string[] = [];
  if (fs.existsSync(l.versionsDir)) {
    for (const entry of fs.readdirSync(l.versionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || keep.has(entry.name)) continue;
      const full = path.join(l.versionsDir, entry.name);
      fs.rmSync(full, { recursive: true, force: true });
      removed.push(full);
    }
  }
  const receipt = writeReceipt(env, {
    ok: true,
    action: "prune",
    fromVersion: current,
    toVersion: current,
    asset: env.asset,
    installedPath: versionBinaryPath(env, current),
    ...(previous === undefined ? {} : { previousVersion: previous, previousPath: versionBinaryPath(env, previous) }),
    launcherPath: l.launcherPath,
    timestamp: new Date().toISOString(),
  });
  return { kept: [...keep], removed, receiptPath: receipt.receiptPath };
}

function lastSuccessfulSwitch(env: UpdaterEnv): UpdateReceipt | undefined {
  const dir = receiptsDir(env);
  if (!fs.existsSync(dir)) return undefined;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().reverse();
  for (const file of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as UpdateReceipt;
      if (parsed.ok && (parsed.action === "install" || parsed.action === "rollback") && parsed.fromVersion !== parsed.toVersion) return parsed;
    } catch {
      // A corrupt receipt is skipped; it is evidence, not state.
    }
  }
  return undefined;
}
