/**
 * `trent update` and `trent desktop`: the two commands built on `@trent/core/updater`.
 *
 * Both share one release source. `--insecure-base-url` is the ONLY way to make the CLI honour
 * `TRENT_RELEASE_BASE_URL` (plus `TRENT_RELEASE_CA_FILE` and `TRENT_RELEASE_PUBLIC_KEY_FILE`, for
 * a test server signed with a test key); the variables on their own are ignored, so a poisoned
 * environment cannot redirect an update. `--dry-run` computes the plan with no network and no
 * writes on every subcommand. `--json` comes from `defineCommand`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EXIT, TrentError } from "@trent/core/errors/index.js";
import {
  applyUpdate,
  checkUpdate,
  defaultRunner,
  desktopInstall,
  desktopLaunch,
  desktopPlan,
  desktopStatus,
  desktopUninstall,
  installedVersion,
  manifestPath,
  planUpdate,
  platformAssetName,
  readDesktopManifest,
  rollbackUpdate,
  targetBinaryPath,
  type Channel,
  type DesktopEnv,
  type ReleaseOptions,
  type UpdaterEnv,
} from "@trent/core/updater/index.js";
import type { CommandContext } from "./context.js";
import { CLI_VERSION, type CommandSpec } from "./registry.js";

const SOURCE_OPTIONS = [
  { flags: "--channel <channel>", description: "Release channel: stable (default) or prerelease" },
  { flags: "--insecure-base-url", description: "Honour TRENT_RELEASE_BASE_URL instead of GitHub Releases (testing only)" },
] as const;

/** Exit code for `update --check` when a newer release exists: non-zero so a script can branch. */
const UPDATE_AVAILABLE_EXIT = EXIT.CONFIG;

function releaseOptions(opts: Record<string, unknown>, env: NodeJS.ProcessEnv): ReleaseOptions {
  if (opts.insecureBaseUrl !== true) return {};
  const base = env.TRENT_RELEASE_BASE_URL;
  if (base === undefined || base.length === 0) {
    throw new TrentError({ code: EXIT.USAGE, operation: "update", message: "--insecure-base-url was passed but TRENT_RELEASE_BASE_URL is not set" });
  }
  const caFile = env.TRENT_RELEASE_CA_FILE;
  return { insecureBaseUrl: base, ...(caFile === undefined ? {} : { ca: fs.readFileSync(caFile, "utf8") }) };
}

function publicKeyOverride(opts: Record<string, unknown>, env: NodeJS.ProcessEnv): string | undefined {
  const file = env.TRENT_RELEASE_PUBLIC_KEY_FILE;
  if (opts.insecureBaseUrl !== true || file === undefined) return undefined;
  return fs.readFileSync(file, "utf8");
}

function channelOf(opts: Record<string, unknown>): Channel {
  const value = opts.channel;
  if (value === undefined || value === "stable") return "stable";
  if (value === "prerelease") return "prerelease";
  throw new TrentError({ code: EXIT.USAGE, operation: "update", message: "unknown channel; use stable or prerelease", target: String(value) });
}

function updaterEnv(ctx: CommandContext, opts: Record<string, unknown>): UpdaterEnv {
  const env = process.env;
  const publicKey = publicKeyOverride(opts, env);
  return {
    home: ctx.config().getBaseDir(),
    currentVersion: CLI_VERSION,
    asset: platformAssetName(),
    release: releaseOptions(opts, env),
    ...(publicKey === undefined ? {} : { publicKey }),
  };
}

function desktopEnv(ctx: CommandContext, opts: Record<string, unknown>): DesktopEnv {
  const env = process.env;
  const publicKey = publicKeyOverride(opts, env);
  return {
    home: ctx.config().getBaseDir(),
    userHome: env.HOME ?? env.USERPROFILE ?? os.homedir(),
    platform: process.platform,
    arch: process.arch,
    release: releaseOptions(opts, env),
    ...(publicKey === undefined ? {} : { publicKey }),
    run: defaultRunner,
  };
}

function optionalVersion(opts: Record<string, unknown>): string | undefined {
  return typeof opts.to === "string" ? opts.to : undefined;
}

export const updateSpec: CommandSpec = {
  name: "update",
  description: "Update the Trent CLI from a signed release: check, apply, or roll back",
  options: [
    { flags: "--check", description: "Only check; exit 0 when up to date, non-zero when an update exists" },
    { flags: "--rollback", description: "Restore the previous binary kept by the last update" },
    { flags: "--to <version>", description: "Install a specific version instead of the latest" },
    { flags: "--force", description: "Allow a downgrade or a reinstall of the same version" },
    ...SOURCE_OPTIONS,
  ],
  async run(ctx, opts) {
    const env = updaterEnv(ctx, opts);
    const channel = channelOf(opts);
    const mode = opts.rollback === true ? "rollback" : opts.check === true ? "check" : "apply";
    if (ctx.dryRun) {
      return {
        data: {
          dryRun: true,
          command: "update",
          mode,
          currentVersion: installedVersion(env),
          asset: env.asset,
          source: env.release.insecureBaseUrl ?? "https://github.com",
          targetPath: targetBinaryPath(env),
          channel,
        },
      };
    }
    if (mode === "rollback") return { data: { ...(await rollbackUpdate(env)) } };
    if (mode === "check") {
      const check = await checkUpdate(env, channel);
      return { data: { ...check }, ...(check.updateAvailable ? { exitCode: UPDATE_AVAILABLE_EXIT } : {}) };
    }
    const version = typeof opts.to === "string" ? opts.to : undefined;
    const plan = await planUpdate(env, { channel, force: opts.force === true, ...(version === undefined ? {} : { version }) });
    if (plan.action === "up-to-date") return { data: { ok: true, action: "up-to-date", currentVersion: plan.fromVersion } };
    return { data: { ...(await applyUpdate(env, plan)) } };
  },
  render(data, ctx) {
    const d = data as Record<string, unknown>;
    if (d.dryRun === true) return [`  ${ctx.theme.meta(`would ${String(d.mode)} updates for`)} ${ctx.theme.value(String(d.currentVersion))} ${ctx.theme.meta("from")} ${ctx.theme.value(String(d.source))}`];
    if (d.restoredVersion !== undefined) return [`  ${ctx.theme.success("rolled back to")} ${ctx.theme.value(String(d.restoredVersion))}`];
    if (d.updateAvailable === true) return [`  ${ctx.theme.needsApproval("update available")} ${ctx.theme.value(String(d.latestVersion))} ${ctx.theme.meta(`(installed ${String(d.currentVersion)})`)}`];
    if (d.updateAvailable === false) return [`  ${ctx.theme.success("up to date")} ${ctx.theme.value(String(d.currentVersion))}`];
    if (d.action === "up-to-date") return [`  ${ctx.theme.success("up to date")} ${ctx.theme.value(String(d.currentVersion))}`];
    return [`  ${ctx.theme.success("installed")} ${ctx.theme.value(String(d.toVersion))} ${ctx.theme.meta("at")} ${ctx.theme.value(String(d.installedPath))}`, `  ${ctx.theme.meta("receipt")} ${ctx.theme.value(String(d.receiptPath))}`];
  },
};

const installSpec: CommandSpec = {
  name: "install",
  description: "Download, verify and install the Trent Fleet desktop app for this platform",
  options: [
    { flags: "--to <version>", description: "Install a specific release instead of the latest" },
    { flags: "--force", description: "Allow a downgrade" },
    { flags: "--system", description: "macOS: install to /Applications instead of ~/Applications (needs write access)" },
    ...SOURCE_OPTIONS,
  ],
  async run(ctx, opts) {
    const env = desktopEnv(ctx, opts);
    const version = optionalVersion(opts);
    if (ctx.dryRun) {
      const plan = desktopPlan(env, { ...(version === undefined ? {} : { version }), system: opts.system === true });
      return { data: { dryRun: true, command: "desktop install", ...plan, manifest: manifestPath(env.home) } };
    }
    const manifest = await desktopInstall(env, { channel: channelOf(opts), force: opts.force === true, system: opts.system === true, ...(version === undefined ? {} : { version }) });
    return { data: { ok: true, ...manifest } };
  },
  render(data, ctx) {
    const d = data as Record<string, unknown>;
    if (d.dryRun === true) return [`  ${ctx.theme.meta("would install")} ${ctx.theme.value(String(d.bundle))} ${ctx.theme.meta("into")} ${ctx.theme.value(String(d.installDir))}`];
    return [`  ${ctx.theme.success("installed Trent Fleet")} ${ctx.theme.value(String(d.version))} ${ctx.theme.meta("at")} ${ctx.theme.value(String((d.paths as string[])[0] ?? ""))}`];
  },
};

const launchSpec: CommandSpec = {
  name: "launch",
  description: "Open the installed Trent Fleet desktop app",
  options: [...SOURCE_OPTIONS],
  async run(ctx, opts) {
    const env = desktopEnv(ctx, opts);
    if (ctx.dryRun) {
      const manifest = readDesktopManifest(env.home);
      return { data: { dryRun: true, command: "desktop launch", installed: manifest !== undefined && manifest.uninstalledAt === undefined, ...(manifest === undefined ? {} : { launch: manifest.launch }) } };
    }
    return { data: { ok: true, ...(await desktopLaunch(env)) } };
  },
  render(data, ctx) {
    const d = data as Record<string, unknown>;
    if (d.dryRun === true) return [`  ${ctx.theme.meta("would launch")} ${ctx.theme.value(d.installed === true ? JSON.stringify(d.launch) : "nothing (not installed)")}`];
    return [`  ${ctx.theme.success("launched Trent Fleet")} ${ctx.theme.value(String(d.version))}`];
  },
};

const statusSpec: CommandSpec = {
  name: "status",
  description: "Show the installed desktop app version and whether a newer release exists",
  options: [{ flags: "--no-check", description: "Do not contact the release source" }, ...SOURCE_OPTIONS],
  async run(ctx, opts) {
    const env = desktopEnv(ctx, opts);
    if (ctx.dryRun) {
      const manifest = readDesktopManifest(env.home);
      return { data: { dryRun: true, command: "desktop status", installed: manifest !== undefined && manifest.uninstalledAt === undefined, manifest: manifestPath(env.home) } };
    }
    const status = await desktopStatus(env, { checkLatest: opts.check !== false, channel: channelOf(opts) });
    return { data: { ...status } };
  },
  render(data, ctx) {
    const d = data as Record<string, unknown>;
    if (d.installed !== true) return [`  ${ctx.theme.meta("desktop app")} ${ctx.theme.value("not installed")}`];
    const lines = [`  ${ctx.theme.meta("desktop app")} ${ctx.theme.value(String(d.version))} ${ctx.theme.meta("at")} ${ctx.theme.value(String(d.path))}`];
    if (d.updateAvailable === true) lines.push(`  ${ctx.theme.needsApproval("update available")} ${ctx.theme.value(String(d.latestVersion))}`);
    else if (d.latestVersion !== undefined) lines.push(`  ${ctx.theme.success("up to date")}`);
    return lines;
  },
};

const uninstallSpec: CommandSpec = {
  name: "uninstall",
  description: "Remove the desktop app files recorded in the manifest, nothing else",
  options: [{ flags: "--yes", description: "Also remove the manifest under ~/.trent/desktop" }, ...SOURCE_OPTIONS],
  async run(ctx, opts) {
    const env = desktopEnv(ctx, opts);
    const manifest = readDesktopManifest(env.home);
    if (ctx.dryRun) {
      return { data: { dryRun: true, command: "desktop uninstall", wouldRemove: manifest?.uninstalledAt === undefined ? (manifest?.paths ?? []) : [], wouldRemoveData: opts.yes === true, manifest: manifestPath(env.home) } };
    }
    return { data: { ok: true, ...(await desktopUninstall(env, { yes: opts.yes === true })) } };
  },
  render(data, ctx) {
    const d = data as Record<string, unknown>;
    const list = (d.dryRun === true ? d.wouldRemove : d.removed) as string[];
    const lines = list.map((p) => `  ${ctx.theme.meta(d.dryRun === true ? "would remove" : "removed")} ${ctx.theme.value(p)}`);
    if (lines.length === 0) lines.push(`  ${ctx.theme.meta("nothing to remove")}`);
    if (d.dryRun !== true && d.removedData !== true) lines.push(`  ${ctx.theme.meta("kept")} ${ctx.theme.value(String(d.manifestPath))} ${ctx.theme.meta("(pass --yes to remove it)")}`);
    return lines;
  },
};

export const desktopSpec: CommandSpec = {
  name: "desktop",
  description: "Install, launch, inspect or remove the Trent Fleet desktop app",
  subcommands: [installSpec, launchSpec, statusSpec, uninstallSpec],
};
