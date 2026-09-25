/**
 * `update`, `uninstall`, and the `serve` deprecation shim.
 */

import fs from "node:fs";
import { ConfigManager } from "@trent/core/config/index.js";
import { UpdateChecker } from "@trent/core/updater/index.js";
import { EXIT, TrentError } from "@trent/core/errors/index.js";
import { refuseUnderLiveWriters } from "@trent/core/profile/locks.js";
import { CLI_VERSION, type CommandSpec } from "../registry.js";

export const updateSpec: CommandSpec = {
  name: "update",
  description: "Check whether a newer Trent Fleet release is available",
  async run(ctx) {
    if (ctx.dryRun) {
      return { data: { dryRun: true, command: "update", currentVersion: CLI_VERSION } };
    }
    const info = await new UpdateChecker(CLI_VERSION).checkForUpdates();
    return { data: { ...info } };
  },
  render(data, ctx) {
    const d = data as { updateAvailable?: boolean; latestVersion?: string; currentVersion?: string };
    if ((data as { dryRun?: boolean }).dryRun === true) {
      return [`  ${ctx.theme.meta("would check for updates from")} ${ctx.theme.value(String(d.currentVersion))}`];
    }
    return d.updateAvailable === true
      ? [`  ${ctx.theme.needsApproval("update available")} ${ctx.theme.value(String(d.latestVersion))}`]
      : [`  ${ctx.theme.success("up to date")} ${ctx.theme.value(String(d.currentVersion))}`];
  },
};

export const uninstallSpec: CommandSpec = {
  name: "uninstall",
  description: "Remove this profile's Trent data directory",
  options: [
    { flags: "--yes", description: "Confirm removal; required, since this deletes data" },
    { flags: "--all-profiles", description: "Remove the whole Trent base directory" },
    { flags: "--force", description: "Remove even while a REPL, gateway, cron runner or run is writing a profile being removed" },
  ],
  run(ctx, opts) {
    const manager = ctx.config();
    const target = opts.allProfiles === true ? manager.getBaseDir() : manager.getProfileDir();

    if (ctx.dryRun) {
      return {
        data: {
          dryRun: true,
          command: "uninstall",
          wouldRemove: target,
          exists: fs.existsSync(target),
        },
      };
    }
    if (opts.yes !== true) {
      throw new TrentError({
        code: EXIT.USAGE,
        operation: "uninstall",
        message: "refusing to delete data without --yes",
        target,
      });
    }
    // Deleting a profile out from under a live gateway or REPL is the worst version of maintenance
    // under a writer. The default profile's directory IS the base directory, which holds every
    // named profile, so removing it (or --all-profiles) checks the writers of all of them.
    const profileDirs = target === manager.getBaseDir()
      ? manager.listProfiles().map((profile) => new ConfigManager({ baseDir: manager.getBaseDir(), profile }).getProfileDir())
      : [target];
    refuseUnderLiveWriters({ profileDirs, operation: "uninstall", force: opts.force === true, warn: (line) => ctx.err(line) });
    const existed = fs.existsSync(target);
    if (existed) fs.rmSync(target, { recursive: true, force: true });
    return { data: { removed: target, existed } };
  },
  render(data, ctx) {
    const d = data as { removed?: string; wouldRemove?: string; dryRun?: boolean };
    return d.dryRun === true
      ? [`  ${ctx.theme.meta("would remove")} ${ctx.theme.value(String(d.wouldRemove))}`]
      : [`  ${ctx.theme.success("removed")} ${ctx.theme.value(String(d.removed))}`];
  },
};

/**
 * `trent serve` started the A2A server. The desktop needs a web server under that name, so the
 * command is retired: this shim names both replacements and exits 2 so a script notices.
 */
export const serveShimSpec: CommandSpec = {
  name: "serve",
  description: "Deprecated: use `trent a2a serve` for A2A, or `trent web` for the web server",
  hidden: true,
  run() {
    throw new TrentError({
      code: EXIT.USAGE,
      operation: "serve",
      message:
        "`trent serve` has been split: use `trent a2a serve` for the agent-to-agent server, or `trent web` for the web server",
    });
  },
};
