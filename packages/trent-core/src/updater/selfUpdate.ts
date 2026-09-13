/**
 * `trent update`: check, plan, apply, rollback. Every apply, successful or not, leaves a
 * machine-readable receipt under `<home>/logs/update_receipts/`, so "what happened to my binary"
 * has an answer that does not depend on scrollback.
 *
 * Layout under `<home>` (the installer's `~/.trent`): `bin/trent` is the binary that gets replaced,
 * `bin/trent.previous` is the rollback target, and `current` records the active version.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { EXIT, TrentError } from "../errors/index.js";
import { installAtomically, previousPath, rollbackInstall } from "./install.js";
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
  /** Override the binary path; defaults to `<home>/bin/trent[.exe]`. */
  targetPath?: string;
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
  targetPath: string;
  force: boolean;
  source: string;
}

export interface UpdateReceipt {
  ok: boolean;
  action: "install" | "rollback";
  fromVersion: string;
  toVersion: string;
  asset: string;
  sha256?: string;
  installedPath: string;
  previousPath?: string;
  timestamp: string;
  error?: string;
  receiptPath: string;
}

export function platformAssetName(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  const os = platform === "win32" ? "windows" : platform;
  return `trent-${os}-${arch}${platform === "win32" ? ".exe" : ""}`;
}

export function targetBinaryPath(env: UpdaterEnv): string {
  return env.targetPath ?? path.join(env.home, "bin", process.platform === "win32" ? "trent.exe" : "trent");
}

export function installedVersion(env: UpdaterEnv): string {
  const file = path.join(env.home, "current");
  if (fs.existsSync(file)) {
    const recorded = fs.readFileSync(file, "utf8").trim();
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
    targetPath: targetBinaryPath(env),
    force,
    source: describeSource(env.release),
  };
}

async function reportedVersion(binary: string): Promise<string> {
  const { stdout } = await execFileAsync(binary, ["--version"], { timeout: 30_000 });
  return stdout.trim();
}

/** Download, verify, install atomically, prove the binary runs, record the receipt. */
export async function applyUpdate(env: UpdaterEnv, plan: UpdatePlan, signal?: AbortSignal): Promise<UpdateReceipt> {
  const timestamp = new Date().toISOString();
  const base = { action: "install" as const, fromVersion: plan.fromVersion, toVersion: plan.toVersion, asset: plan.asset, installedPath: plan.targetPath, timestamp };
  if (plan.action === "up-to-date") return writeReceipt(env, { ...base, ok: true });

  const dirs: string[] = [];
  try {
    const artifact = await fetchArtifact(plan.asset, plan.toVersion, signal, env.release);
    dirs.push(artifact.dir);
    const sums = await fetchArtifact("SHA256SUMS", plan.toVersion, signal, env.release);
    dirs.push(sums.dir);
    const sig = await fetchArtifact("SHA256SUMS.minisig", plan.toVersion, signal, env.release);
    dirs.push(sig.dir);

    const verified = await verifyArtifact(artifact.path, sums.path, sig.path, env.publicKey === undefined ? {} : { publicKey: env.publicKey });
    const placed = installAtomically(verified.path, plan.targetPath);

    const reported = await reportedVersion(plan.targetPath).catch((error: unknown) => {
      throw new TrentError({ code: EXIT.CONFIG, operation: "updater.apply", message: `installed binary failed to run --version: ${error instanceof Error ? error.message : String(error)}` });
    });
    if (reported !== plan.toVersion) {
      if (placed.previous !== undefined) rollbackInstall(plan.targetPath);
      throw new TrentError({ code: EXIT.CONFIG, operation: "updater.apply", message: `installed binary reports version '${reported}', expected '${plan.toVersion}'; rolled back`, target: plan.targetPath });
    }
    fs.mkdirSync(env.home, { recursive: true });
    fs.writeFileSync(path.join(env.home, "current"), `${plan.toVersion}\n`);
    return writeReceipt(env, { ...base, ok: true, sha256: verified.sha256, ...(placed.previous === undefined ? {} : { previousPath: placed.previous }) });
  } catch (error) {
    const receipt = writeReceipt(env, { ...base, ok: false, error: error instanceof Error ? error.message : String(error) });
    if (error instanceof TrentError) {
      throw new TrentError({ code: error.code, operation: error.operation, message: error.message, context: { receiptPath: receipt.receiptPath } });
    }
    throw error;
  } finally {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  }
}

export interface RollbackResult {
  restoredPath: string;
  restoredVersion: string;
  receiptPath: string;
}

/** Restore `bin/trent.previous`. The version comes from the last successful install receipt. */
export async function rollbackUpdate(env: UpdaterEnv): Promise<RollbackResult> {
  const target = targetBinaryPath(env);
  const last = lastSuccessfulInstall(env);
  const { restored } = rollbackInstall(target);
  const restoredVersion = last?.fromVersion ?? "unknown";
  if (last !== undefined) fs.writeFileSync(path.join(env.home, "current"), `${restoredVersion}\n`);
  const receipt = writeReceipt(env, {
    ok: true,
    action: "rollback",
    fromVersion: last?.toVersion ?? installedVersion(env),
    toVersion: restoredVersion,
    asset: env.asset,
    installedPath: restored,
    previousPath: previousPath(target),
    timestamp: new Date().toISOString(),
  });
  return { restoredPath: restored, restoredVersion, receiptPath: receipt.receiptPath };
}

function lastSuccessfulInstall(env: UpdaterEnv): UpdateReceipt | undefined {
  const dir = receiptsDir(env);
  if (!fs.existsSync(dir)) return undefined;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().reverse();
  for (const file of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as UpdateReceipt;
      if (parsed.ok && parsed.action === "install" && parsed.previousPath !== undefined) return parsed;
    } catch {
      // A corrupt receipt is skipped; it is evidence, not state.
    }
  }
  return undefined;
}
