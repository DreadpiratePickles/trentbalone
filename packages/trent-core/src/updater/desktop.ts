/**
 * `trent desktop`: install, launch, status and uninstall the Tauri desktop bundle from an existing
 * CLI install. Same release source, same signature path, same refusal to downgrade as the CLI.
 *
 * Where things go, per platform, none of it needing elevation:
 *   macOS   ~/Applications/Trent Fleet.app       (/Applications only with --system)
 *   Linux   ~/.local/bin/trent-fleet.AppImage + ~/.local/share/applications/trent-fleet.desktop
 *   Windows the NSIS installer runs silently and installs under %LOCALAPPDATA%\Trent Fleet
 * `<home>/desktop/manifest.json` records exactly what was written, and uninstall removes exactly
 * that list and nothing else.
 */

import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { EXIT, TrentError } from "../errors/index.js";
import { installAtomically } from "./install.js";
import { describeSource, fetchArtifact, privateTempDir, releaseDownloadUrl, resolveLatest, type Channel, type ReleaseOptions } from "./release.js";
import { verifyArtifact } from "./verify.js";
import { assertValidVersion, compareVersions } from "./version.js";

export const DESKTOP_PRODUCT = "Trent Fleet";
const APP_NAME = `${DESKTOP_PRODUCT}.app`;

export type CommandRunner = (command: string, args: string[], options?: { detached?: boolean }) => Promise<{ stdout: string; stderr: string }>;

export interface DesktopEnv {
  /** Trent home, normally `~/.trent`. */
  home: string;
  /** The user's home directory, for `~/Applications` and `~/.local`. */
  userHome: string;
  platform: NodeJS.Platform;
  arch: string;
  release: ReleaseOptions;
  publicKey?: string;
  run: CommandRunner;
}

export interface DesktopManifest {
  version: string;
  platform: string;
  arch: string;
  format: "dmg" | "appimage" | "nsis" | string;
  bundle: string;
  sha256: string;
  installedAt: string;
  paths: string[];
  launch: { command: string; args: string[] };
  uninstalledAt?: string;
}

export interface DesktopPlan {
  version: string | undefined;
  bundle: string;
  format: string;
  url: string | undefined;
  installDir: string;
  source: string;
}

function fail(message: string, target?: string, code: 2 | 3 | 5 = EXIT.CONFIG): TrentError {
  return new TrentError({ code, operation: "desktop", message, ...(target === undefined ? {} : { target }) });
}

/** The default runner: `execFile` for a command we wait on, a detached `spawn` for a launch. */
export const defaultRunner: CommandRunner = (command, args, options) =>
  new Promise((resolve, reject) => {
    if (options?.detached === true) {
      const child = spawn(command, args, { detached: true, stdio: "ignore" });
      child.on("error", reject);
      child.on("spawn", () => {
        child.unref();
        resolve({ stdout: "", stderr: "" });
      });
      return;
    }
    execFile(command, args, { timeout: 300_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(fail(`${command} ${args[0] ?? ""} failed: ${error.message.split("\n")[0] ?? ""}`));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });

function formatFor(platform: NodeJS.Platform): "dmg" | "appimage" | "nsis" {
  if (platform === "darwin") return "dmg";
  if (platform === "linux") return "appimage";
  if (platform === "win32") return "nsis";
  throw fail(`unsupported platform for the desktop app: ${platform}`, platform, EXIT.USAGE);
}

/** The file name Tauri gives the bundle. Version is validated unless it is the dry-run placeholder. */
export function desktopBundleName(platform: NodeJS.Platform, arch: string, version: string): string {
  const v = version === "<latest>" ? version : assertValidVersion(version, "desktop.bundle");
  const format = formatFor(platform);
  if (format === "dmg") {
    if (arch !== "arm64" && arch !== "x64") throw fail(`unsupported macOS architecture: ${arch}`, arch, EXIT.USAGE);
    return `${DESKTOP_PRODUCT}_${v}_${arch === "arm64" ? "aarch64" : "x64"}.dmg`;
  }
  if (format === "appimage") {
    if (arch !== "x64") throw fail(`unsupported Linux architecture: ${arch}`, arch, EXIT.USAGE);
    return `trent-fleet_${v}_amd64.AppImage`;
  }
  if (arch !== "x64") throw fail(`unsupported Windows architecture: ${arch}`, arch, EXIT.USAGE);
  return `${DESKTOP_PRODUCT}_${v}_x64-setup.exe`;
}

export function manifestPath(home: string): string {
  return path.join(home, "desktop", "manifest.json");
}

export function readDesktopManifest(home: string): DesktopManifest | undefined {
  const file = manifestPath(home);
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, "utf8")) as DesktopManifest;
}

function writeManifest(home: string, manifest: DesktopManifest): void {
  fs.mkdirSync(path.dirname(manifestPath(home)), { recursive: true });
  fs.writeFileSync(manifestPath(home), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

function installDirFor(env: DesktopEnv, system: boolean): string {
  const format = formatFor(env.platform);
  if (format === "dmg") return system ? "/Applications" : path.join(env.userHome, "Applications");
  if (format === "appimage") return path.join(env.userHome, ".local", "bin");
  return path.join(process.env.LOCALAPPDATA ?? path.join(env.userHome, "AppData", "Local"), DESKTOP_PRODUCT);
}

/** Everything install would do, computed with no network and no writes. */
export function desktopPlan(env: DesktopEnv, options: { version?: string; system?: boolean }): DesktopPlan {
  const version = options.version === undefined ? undefined : assertValidVersion(options.version, "desktop.plan");
  const bundle = desktopBundleName(env.platform, env.arch, version ?? "<latest>");
  return {
    version,
    bundle,
    format: formatFor(env.platform),
    url: version === undefined ? undefined : releaseDownloadUrl(bundle, version, env.release).href,
    installDir: installDirFor(env, options.system === true),
    source: describeSource(env.release),
  };
}

export interface DesktopInstallOptions {
  version?: string;
  channel?: Channel;
  force?: boolean;
  system?: boolean;
  signal?: AbortSignal;
}

async function installDmg(env: DesktopEnv, bundlePath: string, installDir: string, ours: Set<string>): Promise<DesktopManifest["launch"] & { paths: string[] }> {
  const mountpoint = privateTempDir("trent-dmg-");
  await env.run("hdiutil", ["attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mountpoint, bundlePath]);
  try {
    const app = fs.readdirSync(mountpoint).find((n) => n === APP_NAME) ?? fs.readdirSync(mountpoint).find((n) => n.endsWith(".app"));
    if (app === undefined) throw fail("disk image contains no .app bundle", bundlePath);
    const dest = path.join(installDir, app);
    fs.mkdirSync(installDir, { recursive: true });
    if (fs.existsSync(dest)) {
      if (ours.has(dest)) fs.rmSync(dest, { recursive: true, force: true });
      else fs.renameSync(dest, `${dest}.broken-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    }
    fs.cpSync(path.join(mountpoint, app), dest, { recursive: true, verbatimSymlinks: true });
    return { command: "open", args: ["-a", dest], paths: [dest] };
  } finally {
    await env.run("hdiutil", ["detach", mountpoint, "-quiet"]).catch(() => ({ stdout: "", stderr: "" }));
    fs.rmSync(mountpoint, { recursive: true, force: true });
  }
}

function installAppImage(env: DesktopEnv, bundlePath: string, installDir: string): DesktopManifest["launch"] & { paths: string[] } {
  const appImage = path.join(installDir, "trent-fleet.AppImage");
  const placed = installAtomically(bundlePath, appImage);
  if (placed.previous !== undefined) fs.rmSync(placed.previous, { force: true });
  const entryDir = path.join(env.userHome, ".local", "share", "applications");
  const entry = path.join(entryDir, "trent-fleet.desktop");
  fs.mkdirSync(entryDir, { recursive: true });
  fs.writeFileSync(entry, ["[Desktop Entry]", "Type=Application", `Name=${DESKTOP_PRODUCT}`, `Exec=${appImage}`, "Terminal=false", "Categories=Development;", ""].join("\n"));
  return { command: appImage, args: [], paths: [appImage, entry] };
}

async function installNsis(env: DesktopEnv, bundlePath: string, installDir: string): Promise<DesktopManifest["launch"] & { paths: string[] }> {
  await env.run(bundlePath, ["/S", `/D=${installDir}`]);
  return { command: path.join(installDir, `${DESKTOP_PRODUCT}.exe`), args: [], paths: [installDir] };
}

export async function desktopInstall(env: DesktopEnv, options: DesktopInstallOptions): Promise<DesktopManifest & { bundle: string }> {
  const existing = readDesktopManifest(env.home);
  const installed = existing !== undefined && existing.uninstalledAt === undefined ? existing : undefined;
  const version = options.version !== undefined ? assertValidVersion(options.version, "desktop.install") : (await resolveLatest(options.channel ?? "stable", env.release, options.signal)).version;
  if (installed !== undefined && options.force !== true && compareVersions(version, installed.version) < 0) {
    throw fail(`refusing to downgrade the desktop app from ${installed.version} to ${version}; pass --force to move backwards`, version, EXIT.USAGE);
  }
  const plan = desktopPlan(env, { version, ...(options.system === undefined ? {} : { system: options.system }) });

  const dirs: string[] = [];
  try {
    const bundle = await fetchArtifact(plan.bundle, version, options.signal, env.release);
    dirs.push(bundle.dir);
    const sums = await fetchArtifact("SHA256SUMS", version, options.signal, env.release);
    dirs.push(sums.dir);
    const sig = await fetchArtifact("SHA256SUMS.minisig", version, options.signal, env.release);
    dirs.push(sig.dir);
    const verified = await verifyArtifact(bundle.path, sums.path, sig.path, env.publicKey === undefined ? {} : { publicKey: env.publicKey });

    const ours = new Set(installed?.paths ?? []);
    const placed =
      plan.format === "dmg"
        ? await installDmg(env, verified.path, plan.installDir, ours)
        : plan.format === "appimage"
          ? installAppImage(env, verified.path, plan.installDir)
          : await installNsis(env, verified.path, plan.installDir);

    const manifest: DesktopManifest = {
      version,
      platform: env.platform,
      arch: env.arch,
      format: plan.format,
      bundle: plan.bundle,
      sha256: verified.sha256,
      installedAt: new Date().toISOString(),
      paths: placed.paths,
      launch: { command: placed.command, args: placed.args },
    };
    writeManifest(env.home, manifest);
    return manifest;
  } finally {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  }
}

function requireInstalled(env: DesktopEnv): DesktopManifest {
  const manifest = readDesktopManifest(env.home);
  if (manifest === undefined || manifest.uninstalledAt !== undefined) {
    throw fail("the desktop app is not installed; run `trent desktop install`", manifestPath(env.home));
  }
  return manifest;
}

export async function desktopLaunch(env: DesktopEnv): Promise<{ command: string; args: string[]; version: string }> {
  const manifest = requireInstalled(env);
  const { command, args } = manifest.launch;
  const target = command === "open" ? (args[1] ?? "") : command;
  if (!fs.existsSync(target)) throw fail("the installed desktop app is missing; run `trent desktop install` again", target);
  await env.run(command, args, { detached: command !== "open" });
  return { command, args, version: manifest.version };
}

export interface DesktopStatus {
  installed: boolean;
  version?: string;
  path?: string;
  installedAt?: string;
  latestVersion?: string;
  updateAvailable?: boolean;
  source: string;
}

export async function desktopStatus(env: DesktopEnv, options: { checkLatest: boolean; channel?: Channel; signal?: AbortSignal }): Promise<DesktopStatus> {
  const manifest = readDesktopManifest(env.home);
  const installed = manifest !== undefined && manifest.uninstalledAt === undefined;
  const status: DesktopStatus = { installed, source: describeSource(env.release) };
  if (installed && manifest !== undefined) {
    status.version = manifest.version;
    status.path = manifest.paths[0] ?? "";
    status.installedAt = manifest.installedAt;
  }
  if (options.checkLatest) {
    const latest = await resolveLatest(options.channel ?? "stable", env.release, options.signal);
    status.latestVersion = latest.version;
    status.updateAvailable = status.version === undefined ? true : compareVersions(latest.version, status.version) > 0;
  }
  return status;
}

export interface DesktopUninstallResult {
  removed: string[];
  missing: string[];
  removedData: boolean;
  manifestPath: string;
}

/** Remove the manifest's paths, nothing else. `<home>/desktop` itself goes only with `yes`. */
export async function desktopUninstall(env: DesktopEnv, options: { yes: boolean }): Promise<DesktopUninstallResult> {
  const manifest = readDesktopManifest(env.home);
  if (manifest === undefined) throw fail("nothing to uninstall: no desktop manifest", manifestPath(env.home));
  const removed: string[] = [];
  const missing: string[] = [];
  if (manifest.uninstalledAt === undefined) {
    if (manifest.format === "nsis") {
      const uninstaller = path.join(manifest.paths[0] ?? "", "uninstall.exe");
      if (fs.existsSync(uninstaller)) await env.run(uninstaller, ["/S"]);
    }
    for (const target of manifest.paths) {
      const resolved = path.resolve(target);
      if (resolved === path.parse(resolved).root || resolved === path.resolve(env.userHome)) throw fail("refusing to remove a root or home directory listed in the manifest", resolved);
      if (!fs.existsSync(resolved)) {
        missing.push(resolved);
        continue;
      }
      fs.rmSync(resolved, { recursive: true, force: true });
      removed.push(resolved);
    }
    writeManifest(env.home, { ...manifest, uninstalledAt: new Date().toISOString() });
  }
  let removedData = false;
  if (options.yes) {
    fs.rmSync(path.dirname(manifestPath(env.home)), { recursive: true, force: true });
    removedData = true;
  }
  return { removed, missing, removedData, manifestPath: manifestPath(env.home) };
}
