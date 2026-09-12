/**
 * What a command sees of the outside world.
 *
 * Every side effect a command can have — stdout, stderr, config, the doctor's check list, starting a
 * server, launching the wizard — arrives through here, so a test drives the whole surface in-process
 * with no spawned binary and no real home directory.
 */

import { ConfigManager } from "@trent/core/config/index.js";
import type { DoctorCheck, DoctorReport } from "@trent/core/doctor/index.js";
import type { SetupMode } from "@trent/core/setup/index.js";
import { createTheme, detectColorMode, type Theme } from "../ui/index.js";

export interface SetupSummary {
  mode: SetupMode;
  success: boolean;
  message: string;
  secretsConfigured: string[];
}

/** Seams a test replaces. Everything defaults to the real implementation. */
export interface CliOverrides {
  /** Replace the doctor's check list (used to force a failing check). */
  doctorChecks?: DoctorCheck[];
  /** Replace the whole doctor run (used to force each failure class). */
  doctorRunAll?: () => Promise<DoctorReport>;
  /** Replace the setup wizard (first-run tests must not prompt). */
  runSetup?: (mode: SetupMode, opts: Record<string, unknown>) => Promise<SetupSummary>;
  /** Replace the REPL launch. */
  startRepl?: (opts: { profile: string; continueSession: boolean }) => Promise<void>;
  /** Replace `now` so a rendered timestamp is stable. */
  now?: () => Date;
}

export interface CommandContext {
  readonly json: boolean;
  readonly color: boolean;
  readonly profile: string;
  readonly dryRun: boolean;
  readonly continueSession: boolean;
  readonly theme: Theme;
  readonly overrides: CliOverrides;
  out(line: string): void;
  err(line: string): void;
  config(): ConfigManager;
}

export interface ContextOptions {
  out: (line: string) => void;
  err: (line: string) => void;
  overrides?: CliOverrides;
  env?: NodeJS.ProcessEnv;
}

function asBool(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function createContext(
  opts: Record<string, unknown>,
  io: ContextOptions,
): CommandContext {
  const env = io.env ?? process.env;
  const json = asBool(opts.json);
  // Commander gives `color: false` for `--no-color`; JSON output is never coloured either way.
  const color = asBool(opts.color, true) && !json;
  const profile = typeof opts.profile === "string" ? opts.profile : (env.TRENT_PROFILE ?? "default");
  const theme = createTheme(color ? detectColorMode(env) : "none");

  let cached: ConfigManager | undefined;

  return {
    json,
    color,
    profile,
    dryRun: asBool(opts.dryRun),
    continueSession: asBool(opts.continue),
    theme,
    overrides: io.overrides ?? {},
    out: io.out,
    err: io.err,
    config(): ConfigManager {
      // Lazy: `trent doctor` and `trent --version` must work with no config on disk, and
      // constructing the manager must never be the thing that fails them.
      cached ??= new ConfigManager({ profile });
      return cached;
    },
  };
}
