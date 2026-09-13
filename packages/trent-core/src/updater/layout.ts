/**
 * The installer's on-disk layout (`scripts/installer/LAYOUT.md`) as seen by the updater: where
 * the launcher, the `current` pointer, the version directories and the staging area live, plus
 * the receipt writer and the one atomic switch (`writeCurrent`). Split out of selfUpdate.ts so
 * the check/plan/apply/rollback logic there stays under the 500-line ceiling.
 */

import fs from "node:fs";
import path from "node:path";
import type { ReleaseOptions } from "./release.js";
import { assertValidVersion } from "./version.js";

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

export function platformOf(env: UpdaterEnv): NodeJS.Platform {
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

export function utcStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Move `versions/<v>` aside the way the installer does, instead of deleting it. */
export function quarantine(dir: string): string {
  const aside = `${dir}.broken-${utcStamp()}`;
  fs.renameSync(dir, aside);
  return aside;
}
