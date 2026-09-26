/**
 * The command registry (Task 2.7).
 *
 * Hermes shipped `--json` on 3 of 28 commands, so the CLI could not be scripted. Here a command can
 * only reach the Commander tree through `defineCommand`, which attaches the global flag set — `--json`
 * included — before the caller sees the object. `assertRegistryInvariants` then re-walks the finished
 * tree and throws if anything slipped in another way, so forgetting the flag is not a thing that can
 * happen quietly.
 *
 * Every handler returns data. The runner decides how it is emitted: `JSON.stringify` in machine mode,
 * `spec.render` through `../ui/` in human mode. A handler that printed for itself would be able to
 * bypass `--json`, so handlers never print.
 */

import { Command, CommanderError } from "commander";
import {
  DEFAULT_EXIT_CODE,
  EXIT,
  isTrentError,
  renderHumanError,
  renderJsonError,
  TrentError,
  type ExitCode,
} from "@trent/core/errors/index.js";
import type { CommandContext } from "./context.js";
import { FLEET_FLAG_HELP, TEAM_FLAG_HELP, launchModeOf } from "../runtime/launch-mode.js"; // [C11.2]

export const CLI_VERSION = "1.0.0";

/** Payload shape a handler may return. Anything `JSON.stringify` round-trips. */
export type JsonData = Record<string, unknown> | unknown[];

export interface CommandOutcome<T extends JsonData = JsonData> {
  data: T;
  /** Override the success code — `doctor` uses it to fail CI on a failing check. */
  exitCode?: ExitCode;
  /** The command bound a socket; the process must not exit when the handler returns. */
  keepAlive?: boolean;
}

/**
 * Set when a handler reports `keepAlive`. Module-scoped because Commander, not the caller, invokes
 * the action, so there is nowhere else to hand the fact back from.
 */
let keepAliveFlag = false;

/** Read and clear the keep-alive flag. Called once per `runCli`. */
export function consumeKeepAlive(): boolean {
  const value = keepAliveFlag;
  keepAliveFlag = false;
  return value;
}

export interface OptionSpec {
  /** Commander flag string, e.g. `--port <port>`. */
  flags: string;
  description: string;
  defaultValue?: string | boolean;
}

export interface CommandSpec<T extends JsonData = JsonData> {
  /** Commander name plus argument declarations, e.g. `install <agentId>`. */
  name: string;
  description: string;
  options?: readonly OptionSpec[];
  subcommands?: readonly CommandSpec[];
  /** Omitted on a pure group; the registry then supplies a subcommand listing. */
  run?: (
    ctx: CommandContext,
    opts: Record<string, unknown>,
    args: readonly string[],
  ) => Promise<CommandOutcome<T>> | CommandOutcome<T>;
  /** Human rendering. Returns lines; never called in `--json` mode. */
  render?: (data: T, ctx: CommandContext) => string[];
  /** Hidden from the help listing but still registered (the `serve` shim). */
  hidden?: boolean;
}

/**
 * Attached to every command and subcommand, without exception.
 * `--no-color` gives Commander a `color` boolean that defaults true.
 */
const GLOBAL_OPTIONS: readonly OptionSpec[] = [
  { flags: "--json", description: "Emit machine-readable JSON on stdout" },
  { flags: "--profile <name>", description: "Configuration profile to use" },
  { flags: "--no-color", description: "Disable ANSI colour" },
  { flags: "-c, --continue", description: "Continue the last conversation session" },
  { flags: "--version", description: "Print the Trent version and exit" },
  {
    flags: "--dry-run",
    description: "Report what would happen; perform no writes, network calls or listeners",
  },
  // [S2] a launch override of `agent.mode` (runtime/runner-for-mode.ts); it writes nothing
  { flags: "--solo", description: "Run on the solo agent (one agent, no seats) for this launch, overriding agent.mode" },
  // [C11.2] the fleet, the option beside solo, with the same one-launch semantics (runtime/launch-mode.ts)
  { flags: "--team", description: TEAM_FLAG_HELP },
  { flags: "--fleet", description: FLEET_FLAG_HELP },
];

export const GLOBAL_LONG_FLAGS: readonly string[] = GLOBAL_OPTIONS.map(
  (o) => `--${o.flags.replace(/^-\w, /, "").replace(/^--/, "").split(/[ <\[]/)[0] ?? ""}`,
);

/** Everything a running command may reach outside itself. Injected so tests need no processes. */
export interface CommandDeps {
  makeContext: (opts: Record<string, unknown>) => CommandContext;
}

export type ContextFactory = (opts: Record<string, unknown>) => CommandContext;

function subcommandListing(spec: CommandSpec, prefix: string): CommandOutcome {
  const subcommands = (spec.subcommands ?? []).map((s) => ({
    name: s.name.split(" ")[0] ?? s.name,
    description: s.description,
    usage: `${prefix} ${s.name}`.trim(),
  }));
  return { data: { command: prefix, description: spec.description, subcommands } };
}

/**
 * The single door into the Commander tree. Nothing else in the CLI constructs a `Command`.
 */
export function defineCommand(
  parent: Command,
  spec: CommandSpec,
  factory: ContextFactory,
  prefix: string[] = [],
): Command {
  const cmd = parent.command(spec.name, { hidden: spec.hidden === true });
  cmd.description(spec.description);

  for (const opt of GLOBAL_OPTIONS) {
    cmd.option(opt.flags, opt.description);
  }
  for (const opt of spec.options ?? []) {
    if (opt.defaultValue === undefined) cmd.option(opt.flags, opt.description);
    else cmd.option(opt.flags, opt.description, opt.defaultValue);
  }

  const here = [...prefix, spec.name.split(" ")[0] ?? spec.name];
  const label = here.join(" ");

  cmd.action(async (...actionArgs: unknown[]) => {
    // Commander passes: ...declaredArgs, options, command.
    const args = actionArgs.slice(0, Math.max(actionArgs.length - 2, 0)).flatMap((a) => {
      if (a === undefined) return [];
      return Array.isArray(a) ? (a as string[]) : [String(a)];
    });
    // Commander 15 stores an option on the command that DECLARED it, and a parent declaration
    // shadows the child's. `--json` on the root would therefore never reach a subcommand handler,
    // which is exactly the bug this task exists to kill, so the merged view is the only safe read.
    const self = actionArgs[actionArgs.length - 1] as Command;
    const opts = {
      ...(actionArgs[actionArgs.length - 2] as Record<string, unknown>),
      ...self.optsWithGlobals(),
    };
    launchModeOf(opts, label); // [C11.2] `--solo` with `--team`/`--fleet` is a usage error on every command, before it runs
    const ctx = factory(opts);

    if (opts.version === true) {
      emit(ctx, { data: { version: CLI_VERSION } }, () => [CLI_VERSION]);
      return;
    }

    const outcome = spec.run
      ? await spec.run(ctx, opts, args)
      : subcommandListing(spec, label);

    emit(ctx, outcome, spec.render as ((d: JsonData, c: CommandContext) => string[]) | undefined);
  });

  for (const sub of spec.subcommands ?? []) {
    defineCommand(cmd, sub, factory, here);
  }

  return cmd;
}

function emit(
  ctx: CommandContext,
  outcome: CommandOutcome,
  render?: (data: JsonData, ctx: CommandContext) => string[],
): void {
  if (outcome.keepAlive === true) keepAliveFlag = true;

  if (ctx.json) {
    ctx.out(JSON.stringify(outcome.data, null, 2));
  } else {
    const lines = render ? render(outcome.data, ctx) : defaultRender(outcome.data, ctx);
    for (const line of lines) ctx.out(line);
  }
  if (outcome.exitCode !== undefined && outcome.exitCode !== EXIT.OK) {
    throw new ExitSignal(outcome.exitCode);
  }
}

/** A non-zero exit that is not an error — a doctor report that ran fine and found problems. */
export class ExitSignal extends Error {
  constructor(readonly exitCode: ExitCode) {
    super(`exit ${exitCode}`);
    this.name = "ExitSignal";
  }
}

/** Last-resort human rendering for a command with no `render`. Keys and values, no invention. */
function defaultRender(data: JsonData, ctx: CommandContext): string[] {
  if (Array.isArray(data)) return data.map((entry) => `  ${JSON.stringify(entry)}`);
  return Object.entries(data).map(
    ([key, value]) =>
      `  ${ctx.theme.meta(key.padEnd(22, " "))} ${ctx.theme.value(
        typeof value === "string" ? value : JSON.stringify(value),
      )}`,
  );
}

/**
 * Re-walk the finished tree. `defineCommand` already guarantees the flags; this catches a command
 * added by any other route and turns a silent scripting hole into a startup crash.
 */
export function assertRegistryInvariants(root: Command): number {
  let count = 0;
  const walk = (cmd: Command, prefix: string[]): void => {
    for (const child of cmd.commands) {
      const label = [...prefix, child.name()].join(" ");
      count += 1;
      if (!child.options.some((o) => o.long === "--json")) {
        throw new TrentError({
          code: EXIT.USAGE,
          operation: "cli.registry",
          message: `command is not scriptable: no --json`,
          target: label,
        });
      }
      if (child.description().trim() === "") {
        throw new TrentError({
          code: EXIT.USAGE,
          operation: "cli.registry",
          message: "command has no description",
          target: label,
        });
      }
      walk(child, [...prefix, child.name()]);
    }
  };
  walk(root, []);
  return count;
}

/** Commander's own failures carry no Trent exit code; usage errors are 2, help and version are 0. */
export function exitCodeForCommanderError(err: CommanderError): ExitCode {
  if (err.code === "commander.helpDisplayed" || err.code === "commander.help") return EXIT.OK;
  if (err.code === "commander.version") return EXIT.OK;
  return EXIT.USAGE;
}

export function isCommanderError(err: unknown): err is CommanderError {
  return err instanceof CommanderError;
}

/** Turn any throw into an exit code, printing the envelope or the one-line human form. */
export function reportFailure(
  err: unknown,
  json: boolean,
  out: (line: string) => void,
  errOut: (line: string) => void,
): ExitCode {
  if (err instanceof ExitSignal) return err.exitCode;

  if (isCommanderError(err)) {
    const code = exitCodeForCommanderError(err);
    if (code === EXIT.OK) return EXIT.OK;
    const wrapped = new TrentError({
      code,
      operation: "cli.usage",
      message: err.message.replace(/^error: /, ""),
    });
    if (json) out(renderJsonError(wrapped));
    else errOut(renderHumanError(wrapped));
    return code;
  }

  if (json) out(renderJsonError(err));
  else errOut(renderHumanError(err));
  return isTrentError(err) ? err.code : DEFAULT_EXIT_CODE;
}
