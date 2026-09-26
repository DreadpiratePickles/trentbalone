/**
 * [C11.2] The launch override of `agent.mode`, and what a bare launch would start.
 *
 * `--solo` runs solo for this launch, `--team` (alias `--fleet`) runs the fleet; neither leaves the choice to
 * `agent.mode`, and a profile without the key runs the fleet (`DEFAULT_AGENT_MODE`). Naming both runners is a
 * usage error (exit 2), refused before anything starts or writes: on every command (`commands/registry.ts`),
 * on a bare `trent`, and in `modeOverride` (`runner-for-mode.ts`). Kept free of the runtime's imports, because
 * the registry reads it on every command.
 */
import { EXIT, TrentError } from "@trent/core/errors/index.js";
import { NEW_PROFILE_AGENT_MODE, agentMode, type AgentMode } from "@trent/core/config/sections/agent.js";
import type { TrentConfig } from "@trent/core/config/schema.js";

/** `trent --help` and every command's help: the fleet named as the option, in one line. */
export const TEAM_FLAG_HELP = "Run on the team for this launch: the fleet, a planner and a critic over nine role seats (new profiles run solo), overriding agent.mode";
export const FLEET_FLAG_HELP = "Same as --team";

/** The flags as Commander's merged options, or a bare launch's argv, carry them. */
export interface LaunchModeFlags {
  readonly solo?: unknown;
  readonly team?: unknown;
  readonly fleet?: unknown;
}

/** `solo`, `fleet`, or nothing (agent.mode decides). Both named is a usage error naming the command. */
export function launchModeOf(flags: LaunchModeFlags, target?: string): AgentMode | undefined {
  const solo = flags.solo === true;
  const team = flags.team === true || flags.fleet === true;
  if (solo && team) {
    throw new TrentError({
      code: EXIT.USAGE,
      operation: "cli.usage",
      message: "--solo and --team (--fleet) name two runners; pick one for this launch",
      ...(target === undefined ? {} : { target }),
    });
  }
  return solo ? "solo" : team ? "fleet" : undefined;
}

/** What a bare `trent` would open, for `--dry-run`: nothing is opened, run or written to find out. */
export interface BareLaunchPlan {
  readonly launch: "repl" | "tui";
  readonly mode: AgentMode;
  /** No profile on disk: the launch would run quick setup first, which writes `NEW_PROFILE_AGENT_MODE`. */
  readonly firstRun: boolean;
}

export function bareLaunchPlan(
  profile: { exists(): boolean; loadConfig(): TrentConfig },
  override: AgentMode | undefined,
  tui: boolean,
): BareLaunchPlan {
  const firstRun = !profile.exists();
  // The TUI runs the fleet only (docs/solo.md, "Turning it on").
  const mode = tui ? "fleet" : override ?? (firstRun ? NEW_PROFILE_AGENT_MODE : agentMode(profile.loadConfig()));
  return { launch: tui ? "tui" : "repl", mode, firstRun };
}
