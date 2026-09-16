/**
 * What a command sees of the outside world.
 *
 * Every side effect a command can have — stdout, stderr, config, the doctor's check list, starting a
 * server, launching the wizard — arrives through here, so a test drives the whole surface in-process
 * with no spawned binary and no real home directory.
 */

import { ConfigManager } from "@trent/core/config/index.js";
import type { DoctorCheck, DoctorReport } from "@trent/core/doctor/index.js";
import type { GatewayManager, GatewayManagerOptions } from "@trent/core/gateway/index.js";
import type { SetupMode } from "@trent/core/setup/index.js";
import type { HeadlessRuntime, HeadlessRuntimeDeps } from "../runtime/headless.js";
import { createTheme, detectColorMode, type Theme } from "../ui/index.js";

export interface SetupSummary {
  mode: SetupMode;
  success: boolean;
  message: string;
  secretsConfigured: string[];
}

/** What `trent web` hands to `spawn`; a test asserts on every field. */
export interface WebSpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** The slice of `ChildProcess` the web command relies on, so a fake needs no real process. */
export interface WebChild {
  pid?: number | undefined;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
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
  /** Replace the docker CLI `trent sandbox build` runs (a fake needs no daemon). */
  sandboxExec?: (command: string, args: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  /** Replace the `spawn` behind `trent web --start` (a fake asserts the argv and env, and binds the port itself). */
  webSpawn?: (command: string, args: readonly string[], options: WebSpawnOptions) => WebChild;
  /** Replace the browser opener behind `trent web --open`. */
  webOpen?: (url: string) => void;
  /** Where `trent web` looks for `apps/web`; defaults to the working directory and its parents. */
  webRepoRoot?: string;
  /** Replace the headless runtime `trent gateway start` builds (a fake needs no proxy, sandbox or model). */
  gatewayRuntime?: (deps: HeadlessRuntimeDeps) => Promise<HeadlessRuntime>;
  /** Replace the gateway manager `trent gateway start` builds (a test records the options it was built with). */
  gatewayManager?: (configManager: ConfigManager, options: GatewayManagerOptions) => GatewayManager;
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
