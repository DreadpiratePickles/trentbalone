/**
 * The command surface.
 *
 * `buildProgram` returns a fully wired Commander instance; `runCli` executes one argv in-process and
 * returns `{ exitCode, stdout, stderr }`. Nothing here calls `process.exit` — `../index.ts` does that
 * once, at the top, so the whole surface stays testable without spawning a binary.
 *
 * First-run behaviour: bare `trent` with no config launches the setup wizard. `trent doctor` and
 * `trent --version` deliberately do not, because they are exactly what a user runs when the config is
 * the thing that is broken.
 */

import { Command } from "commander";
import { EXIT, type ExitCode } from "@trent/core/errors/index.js";
import { createContext, type CliOverrides, type CommandContext } from "./context.js";
import {
  assertRegistryInvariants,
  CLI_VERSION,
  consumeKeepAlive,
  defineCommand,
  reportFailure,
  type CommandSpec,
  type ContextFactory,
} from "./registry.js";
import { doctorSpec, runSetup, setupSpec } from "./groups/diagnostics.js";
import { configSpec, modelSpec, toolsSpec } from "./groups/configuration.js";
import { fleetSpec, skillsSpec } from "./groups/fleet.js";
import { mcpSpec, sessionsSpec } from "./groups/sessions.js";
import { a2aSpec, acpSpec, egressSpec, gatewaySpec, webSpec } from "./groups/servers.js";
import { serveShimSpec, uninstallSpec } from "./groups/maintenance.js";
import { desktopSpec, updateSpec } from "./desktop.js";
import { improveSpec } from "./improve.js";
import { sandboxSpec } from "./groups/sandbox.js";

export { CLI_VERSION } from "./registry.js";
export type { CommandContext, CliOverrides } from "./context.js";

/** The whole surface, in help order. Adding a command here is the only way to add one. */
export const COMMAND_SPECS: readonly CommandSpec[] = [
  doctorSpec,
  setupSpec,
  modelSpec,
  fleetSpec,
  skillsSpec,
  improveSpec,
  toolsSpec,
  sandboxSpec,
  sessionsSpec,
  configSpec,
  mcpSpec,
  a2aSpec,
  acpSpec,
  gatewaySpec,
  egressSpec,
  webSpec,
  desktopSpec,
  updateSpec,
  uninstallSpec,
  serveShimSpec,
];

/** Commands that must work when there is no config on disk, so first run never blocks them. */
export const NO_CONFIG_COMMANDS: ReadonlySet<string> = new Set(["doctor", "setup", "config", "uninstall"]);

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface BuildOptions {
  io?: CliIo;
  overrides?: CliOverrides;
  env?: NodeJS.ProcessEnv;
}

const CONSOLE_IO: CliIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

/**
 * Build the Commander tree. Every command goes through `defineCommand`, so `--json` and the rest of
 * the global flag set are attached before anything else can touch the object; `assertRegistryInvariants`
 * then re-checks the finished tree and refuses to hand back a program with an unscriptable command.
 */
export function buildProgram(options: BuildOptions = {}): Command {
  const io = options.io ?? CONSOLE_IO;
  const factory: ContextFactory = (opts) =>
    createContext(opts, {
      out: io.out,
      err: io.err,
      ...(options.overrides === undefined ? {} : { overrides: options.overrides }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });

  const program = new Command();
  program
    .name("trent")
    .description("Trent Fleet - autonomous AI cofounder platform")
    .option("--json", "Emit machine-readable JSON on stdout")
    .option("--profile <name>", "Configuration profile to use")
    .option("--no-color", "Disable ANSI colour")
    .option("-c, --continue", "Continue the last conversation session")
    .option("--dry-run", "Report what would happen; perform no writes or network calls")
    .option("--tui", "Launch the interactive terminal UI")
    .version(CLI_VERSION, "--version", "Print the Trent version and exit")
    .allowExcessArguments(false);

  for (const spec of COMMAND_SPECS) defineCommand(program, spec, factory);

  assertRegistryInvariants(program);
  return program;
}

export interface RunResult {
  exitCode: ExitCode;
  stdout: string;
  stderr: string;
  /** True when a command bound a socket and the process should stay alive. */
  keepAlive: boolean;
  /** Set when the invocation asked for an interactive surface the binary entry point owns. */
  launch?: "repl" | "tui";
}

export interface RunOptions {
  overrides?: CliOverrides;
  env?: NodeJS.ProcessEnv;
  /** Mirror captured output to the real streams. Set by the binary entry point. */
  tee?: boolean;
}

/**
 * True when argv carries any non-flag operand. An operand that is not a registered command is a
 * usage error for Commander to report — never a reason to run the first-run wizard.
 */
function hasOperand(argv: readonly string[]): boolean {
  return argv.some((a) => !a.startsWith("-"));
}

/**
 * Run one argv. Returns the exit code rather than taking it — the caller decides whether to exit,
 * which is what lets a server command keep the process alive and a test assert on the number.
 */
export async function runCli(argv: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  const out: string[] = [];
  const err: string[] = [];
  let launch: "repl" | "tui" | undefined;

  const io: CliIo = {
    out: (line) => {
      out.push(line);
      if (options.tee === true) process.stdout.write(`${line}\n`);
    },
    err: (line) => {
      err.push(line);
      if (options.tee === true) process.stderr.write(`${line}\n`);
    },
  };

  const program = buildProgram({
    io,
    ...(options.overrides === undefined ? {} : { overrides: options.overrides }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });

  // Commander must never write directly or kill the process.
  const configure = (cmd: Command): void => {
    cmd.exitOverride();
    cmd.configureOutput({
      writeOut: (s) => io.out(s.replace(/\n$/, "")),
      writeErr: (s) => io.err(s.replace(/\n$/, "")),
    });
    for (const child of cmd.commands) configure(child);
  };
  configure(program);

  const finish = (exitCode: ExitCode): RunResult => ({
    exitCode,
    stdout: out.length > 0 ? `${out.join("\n")}\n` : "",
    stderr: err.length > 0 ? `${err.join("\n")}\n` : "",
    keepAlive: consumeKeepAlive(),
    ...(launch === undefined ? {} : { launch }),
  });

  const globals = extractGlobals(argv);
  const json = globals.json;

  try {
    if (!hasOperand(argv)) {
      // Bare `trent`, or top-level flags only.
      const ctx = createContext(globals.opts, {
        out: io.out,
        err: io.err,
        ...(options.overrides === undefined ? {} : { overrides: options.overrides }),
        ...(options.env === undefined ? {} : { env: options.env }),
      });
      const handled = await handleTopLevel(ctx, globals);
      if (handled.exitCode !== undefined) {
        if (handled.launch !== undefined) launch = handled.launch;
        return finish(handled.exitCode);
      }
    }

    await program.parseAsync([...argv], { from: "user" });
    return finish(EXIT.OK);
  } catch (error) {
    const code = reportFailure(error, json, io.out, io.err);
    return finish(code);
  }
}

interface Globals {
  json: boolean;
  version: boolean;
  help: boolean;
  tui: boolean;
  opts: Record<string, unknown>;
}

function extractGlobals(argv: readonly string[]): Globals {
  const has = (flag: string): boolean => argv.includes(flag);
  const profileIndex = argv.findIndex((a) => a === "--profile" || a === "-p");
  const opts: Record<string, unknown> = {
    json: has("--json"),
    color: !has("--no-color"),
    dryRun: has("--dry-run"),
    continue: has("-c") || has("--continue"),
  };
  if (profileIndex >= 0 && argv[profileIndex + 1] !== undefined) {
    opts.profile = argv[profileIndex + 1];
  }
  return {
    json: has("--json"),
    version: has("--version") || has("-V"),
    help: has("--help") || has("-h"),
    tui: has("--tui"),
    opts,
  };
}

/**
 * Bare `trent` and top-level flags. Returns an exit code when it handled the invocation, or
 * `undefined` to let Commander parse.
 */
async function handleTopLevel(
  ctx: CommandContext,
  globals: Globals,
): Promise<{ exitCode?: ExitCode; launch?: "repl" | "tui" }> {
  if (globals.version) {
    // Must work with no config: this is what a user runs when everything else is broken.
    ctx.out(globals.json ? JSON.stringify({ version: CLI_VERSION }, null, 2) : CLI_VERSION);
    return { exitCode: EXIT.OK };
  }
  if (globals.help) return {};

  const manager = ctx.config();
  if (!manager.exists()) {
    // First run: the wizard, not a failure.
    const summary = await runSetup(ctx, "quick", {});
    ctx.out(
      globals.json
        ? JSON.stringify({ firstRun: true, setup: summary }, null, 2)
        : ctx.theme.success(`Setup complete: ${summary.message}`),
    );
    return { exitCode: summary.success ? EXIT.OK : EXIT.CONFIG };
  }

  if (ctx.overrides.startRepl) {
    await ctx.overrides.startRepl({ profile: ctx.profile, continueSession: ctx.continueSession });
    return { exitCode: EXIT.OK };
  }

  // Config exists and no harness is driving: the binary entry point owns the interactive surface.
  return { exitCode: EXIT.OK, launch: globals.tui ? "tui" : "repl" };
}

/** Back-compatible entry point for callers that already own a Commander program. */
export function registerCommands(program: Command, options: BuildOptions = {}): Command {
  const io = options.io ?? CONSOLE_IO;
  const factory: ContextFactory = (opts) =>
    createContext(opts, {
      out: io.out,
      err: io.err,
      ...(options.overrides === undefined ? {} : { overrides: options.overrides }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
  for (const spec of COMMAND_SPECS) defineCommand(program, spec, factory);
  assertRegistryInvariants(program);
  return program;
}
