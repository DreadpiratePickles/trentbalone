/**
 * The command surface.
 *
 * `buildProgram` returns a fully wired Commander instance; `runCli` executes one argv in-process and
 * returns `{ exitCode, stdout, stderr }`. Nothing here calls `process.exit` — `../index.ts` does that
 * once, at the top, so the whole surface stays testable without spawning a binary.
 *
 * First-run behaviour: bare `trent` with no config launches the setup wizard. `trent doctor` and
 * `trent --version` deliberately do not, because they are exactly what a user runs when the config is
 * the thing that is broken. A first run that finds no provider key still opens the REPL, in DEGRADED
 * mode (`../repl/degraded.ts`), and writes no config, so the next launch runs the wizard again.
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
import { runSpec } from "./groups/run.js";
import { configSpec, modelSpec, toolsSpec } from "./groups/configuration.js";
import { fleetSpec } from "./groups/fleet.js";
import { skillsSpec } from "./groups/skills.js";
import { curatorSpec } from "./groups/curator.js";
import { goalSpec } from "./groups/goal.js";
import { sessionsSpec } from "./groups/sessions.js";
import { mcpSpec } from "./groups/mcp.js";
import { a2aSpec, acpSpec, egressSpec, gatewaySpec, webSpec } from "./groups/servers.js";
import { serveShimSpec, uninstallSpec } from "./groups/maintenance.js";
import { desktopSpec, updateSpec } from "./desktop.js";
import { improveSpec } from "./improve.js";
import { sandboxSpec } from "./groups/sandbox.js";
import { cronSpec } from "./groups/cron.js";
import { heartbeatSpec } from "./groups/heartbeat.js";
import { serviceSpec } from "./groups/service.js";
import { auditSpec } from "./groups/audit.js";
import { approvalsSpec } from "./groups/approvals.js";
import { budgetSpec } from "./groups/budget.js";
import { usageSpec } from "./groups/usage.js";
import { jobsSpec } from "./groups/jobs.js";
import { hooksSpec } from "./groups/hooks.js";
import { workspaceSpec } from "./groups/workspace.js";
import { brainSpec } from "./groups/brain.js";
import { securitySpec } from "./groups/security.js";
import { connectSpec } from "./groups/connect.js";
import { benchSpec } from "./groups/bench.js"; // [C16]
import { FLEET_FLAG_HELP, TEAM_FLAG_HELP, bareLaunchPlan, launchModeOf } from "../runtime/launch-mode.js"; // [C11.2]

export { CLI_VERSION } from "./registry.js";

// [S2] `trent solo`: an alias that starts the REPL in solo mode for this launch (docs/solo.md)
/**
 * Registered so `--help` lists it and every script can find it; `runCli` routes the alias through the
 * same first-run path bare `trent` takes (the wizard, then the REPL), with the mode forced to solo.
 * The action below is that path's last step, for a caller that reaches it through Commander.
 */
const soloSpec: CommandSpec = {
  name: "solo",
  description: "Start the REPL in solo mode: one agent with one tool loop and no seats, overriding agent.mode for this launch",
  async run(ctx) {
    if (ctx.dryRun) return { data: { dryRun: true, command: "solo", launch: "repl", mode: "solo" } };
    if (ctx.overrides.startRepl) await ctx.overrides.startRepl({ profile: ctx.profile, continueSession: ctx.continueSession, mode: "solo" });
    else launchRequest = { launch: "repl", mode: "solo" };
    return { data: { launch: "repl", mode: "solo" } };
  },
  render: () => [],
};

/** Set by `soloSpec` when Commander reached it with no harness; read once by `runCli`. */
let launchRequest: { launch: "repl"; mode: "solo" } | undefined;

/** The tokens that are not flags, and not the value of `--profile`/`-p`, which is the one global that takes one. */
function operands(argv: readonly string[]): string[] {
  return argv.filter((token, index) => !token.startsWith("-") && argv[index - 1] !== "--profile" && argv[index - 1] !== "-p");
}

/** `trent solo`, with any global flags, and no other operand. `--dry-run` reports through the command instead. */
function isSoloAlias(argv: readonly string[]): boolean {
  const words = operands(argv);
  return words.length === 1 && words[0] === "solo" && !argv.includes("--help") && !argv.includes("-h") && !argv.includes("--dry-run");
}
// [S2] end
export type { CommandContext, CliOverrides } from "./context.js";

/** The whole surface, in help order. Adding a command here is the only way to add one. */
export const COMMAND_SPECS: readonly CommandSpec[] = [
  runSpec,
  soloSpec, // [S2]
  doctorSpec,
  setupSpec,
  modelSpec,
  fleetSpec,
  skillsSpec,
  curatorSpec,
  goalSpec,
  improveSpec,
  toolsSpec,
  sandboxSpec,
  sessionsSpec,
  brainSpec,
  configSpec,
  workspaceSpec,
  mcpSpec,
  cronSpec,
  heartbeatSpec,
  serviceSpec,
  auditSpec,
  approvalsSpec,
  budgetSpec,
  usageSpec,
  jobsSpec,
  hooksSpec,
  securitySpec,
  connectSpec,
  a2aSpec,
  acpSpec,
  gatewaySpec,
  egressSpec,
  webSpec,
  desktopSpec,
  updateSpec,
  uninstallSpec,
  serveShimSpec,
  benchSpec, // [C16] the head-to-head bench
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
    .option("--solo", "Run on the solo agent (one agent, no seats) for this launch, overriding agent.mode") // [S2]
    .option("--team", TEAM_FLAG_HELP) // [C11.2] the fleet, the option beside solo
    .option("--fleet", FLEET_FLAG_HELP) // [C11.2]
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
  /** [S2] Set with `launch` when the launch overrides `agent.mode` (`trent solo`, `--solo`; [C11.2] `--team`, `--fleet`). */
  mode?: "solo" | "fleet";
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
  return operands(argv).length > 0; // [S2] `--profile <name>`'s value is not an operand: `trent --profile work` opens the REPL
}

/**
 * Run one argv. Returns the exit code rather than taking it — the caller decides whether to exit,
 * which is what lets a server command keep the process alive and a test assert on the number.
 */
export async function runCli(argv: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  const out: string[] = [];
  const err: string[] = [];
  let launch: "repl" | "tui" | undefined;
  let mode: "solo" | "fleet" | undefined; // [S2] [C11.2]
  launchRequest = undefined; // [S2]

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
    ...(launch !== undefined && mode !== undefined ? { mode } : {}), // [S2]
  });

  const globals = extractGlobals(argv);
  const json = globals.json;

  try {
    if (!hasOperand(argv) || isSoloAlias(argv)) { // [S2] `trent solo` takes bare `trent`'s path
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
        if (handled.mode !== undefined) mode = handled.mode; // [S2] [C11.2] --solo, --team or --fleet
        return finish(handled.exitCode);
      }
    }

    await program.parseAsync([...argv], { from: "user" });
    if (launchRequest !== undefined) ({ launch, mode } = launchRequest); // [S2]
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
  /** [S2] `--solo` or the `trent solo` alias. */
  solo: boolean;
  /** [C11.2] `--team` or `--fleet`. */
  team: boolean;
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
    solo: has("--solo") || isSoloAlias(argv), // [S2]
    team: has("--team") || has("--fleet"), // [C11.2]
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
): Promise<{ exitCode?: ExitCode; launch?: "repl" | "tui"; mode?: "solo" | "fleet" }> { // [C11.2] mode
  if (globals.version) {
    // Must work with no config: this is what a user runs when everything else is broken.
    ctx.out(globals.json ? JSON.stringify({ version: CLI_VERSION }, null, 2) : CLI_VERSION);
    return { exitCode: EXIT.OK };
  }
  if (globals.help) return {};

  const mode = launchModeOf(globals); // [C11.2] --solo, --team (--fleet) or nothing; naming both is a usage error
  if (ctx.dryRun) { // [C11.2] opens nothing and writes nothing (it opened the REPL, or ran first-run setup): names what would start
    const plan = { dryRun: true, command: "trent", profile: ctx.profile, ...bareLaunchPlan(ctx.config(), mode, globals.tui) };
    ctx.out(globals.json ? JSON.stringify(plan, null, 2) : `would open the ${plan.launch.toUpperCase()} on ${plan.mode}${plan.firstRun ? ", after first-run setup" : ""}`);
    return { exitCode: EXIT.OK };
  }

  const manager = ctx.config();
  if (!manager.exists()) {
    // First run: the wizard, not a failure.
    const summary = await runSetup(ctx, "quick", {});
    if (globals.json) {
      // Machine mode opens nothing interactive: one document, and the exit code says what happened.
      ctx.out(JSON.stringify({ firstRun: true, setup: summary }, null, 2));
      return { exitCode: summary.success ? EXIT.OK : EXIT.CONFIG };
    }
    if (summary.success) {
      ctx.out(ctx.theme.success(`Setup complete: ${summary.message}`));
      return { exitCode: EXIT.OK };
    }
    ctx.out(ctx.theme.error(`Setup did not complete: ${summary.message}`));
    // No key is not a reason to see nothing: the REPL opens degraded and its banner says what works
    // without a key and the one command that adds one. Any other stop (a declined confirmation) exits.
    if (summary.reason !== "no-key") return { exitCode: EXIT.CONFIG };
  }

  if (ctx.overrides.startRepl) {
    await ctx.overrides.startRepl({ profile: ctx.profile, continueSession: ctx.continueSession, ...(mode === undefined ? {} : { mode }) }); // [S2] [C11.2]
    return { exitCode: EXIT.OK };
  }

  // Config exists and no harness is driving: the binary entry point owns the interactive surface.
  return { exitCode: EXIT.OK, launch: globals.tui ? "tui" : "repl", ...(mode === undefined ? {} : { mode }) }; // [C11.2] mode
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
