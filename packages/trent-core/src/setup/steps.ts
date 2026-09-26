import { ProviderSchema, ToolsetSchema } from "../config/schema.js";
import type { Provider, Toolset, TrentConfig } from "../config/schema.js";
import type { Choice } from "./ports.js";
import { NEW_PROFILE_AGENT_MODE, agentMode, type AgentMode } from "../config/sections/agent.js"; // [C11.2]
import type { ConfigManager } from "../config/ConfigManager.js"; // [C11.2]
import { EXIT, TrentError } from "../errors/TrentError.js"; // [C11.2]

export const ALL_PROVIDERS: readonly Provider[] = ProviderSchema.options;
export const ALL_TOOLSETS: readonly Toolset[] = ToolsetSchema.options;

/** The two toolsets a Blank Slate keeps. Everything else is written out explicitly. */
export const MINIMAL_TOOLSETS: readonly Toolset[] = ["file_ops", "terminal"];

export const STARTER_AGENTS: readonly string[] = ["ceo", "eng-ai-engineer", "support-responder"];

export function providerChoices(): Array<Choice<Provider>> {
  return ALL_PROVIDERS.map((p) => ({ name: p, value: p }));
}

export function toolsetChoices(): Array<Choice<Toolset>> {
  return ALL_TOOLSETS.map((t) => ({ name: t, value: t }));
}

/** "ceo, eng-ai-engineer" -> ["ceo", "eng-ai-engineer"], duplicates and blanks removed. */
export function parseAgentList(input: string, fallback: readonly string[]): string[] {
  const parsed = [...new Set(input.split(",").map((s) => s.trim()).filter((s) => s !== ""))];
  return parsed.length > 0 ? parsed : [...fallback];
}

/**
 * Write the toolset decision in all three places a later `trent update` might read.
 *
 * `disabled_toolsets` is derived as the exact complement of what was enabled, and the same list is
 * mirrored into `platform_toolsets.cli` and `agent.disabled_toolsets`. Recording the negative
 * explicitly is the point: a config that only lists what is ON lets a future release enable a newly
 * added toolset by default, silently.
 */
export function applyToolsets(config: TrentConfig, enabled: readonly Toolset[]): TrentConfig {
  const on = ALL_TOOLSETS.filter((t) => enabled.includes(t));
  const off = ALL_TOOLSETS.filter((t) => !on.includes(t));

  return {
    ...config,
    toolsets: [...on],
    disabled_toolsets: [...off],
    platform_toolsets: { ...(asRecord(config.platform_toolsets) ?? {}), cli: [...on] },
    agent: { ...(asRecord(config.agent) ?? {}), disabled_toolsets: [...off] },
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function withFleet(config: TrentConfig, agents: readonly string[]): TrentConfig {
  const installed = agents.length > 0 ? [...agents] : [...STARTER_AGENTS];
  const first = installed[0] as string;
  return {
    ...config,
    fleet: { installed_agents: installed, active_agents: [first], default_agent: first },
  };
}

export function withBudget(config: TrentConfig, dailyCents: number, perRunCents: number): TrentConfig {
  return {
    ...config,
    budget: { ...config.budget, daily_cap: dailyCents, per_run_cap: perRunCents },
  };
}

// [C11.2] the runner a setup run writes
/** The two runners, one line each, as every setup screen shows them (quick's is the first-run screen). */
export const AGENT_MODE_LINES: Readonly<Record<AgentMode, string>> = {
  solo: "solo  one agent with one tool loop and no seats (the default for a new profile)",
  fleet: "team  the fleet, the option: a planner and a critic over nine role seats (trent setup --team keeps it; trent --team runs it for one launch)",
};

/** Full setup's question: the same two runners. */
export const AGENT_MODE_CHOICES: ReadonlyArray<Choice<AgentMode>> = [
  { name: "solo: one agent with one tool loop and no seats", value: "solo" },
  { name: "fleet: the team, a planner and a critic over nine role seats", value: "fleet" },
];

/** The runner the user named at setup: `fleet` (`--team`, `--fleet`), `solo` (`--solo`), or none. */
export function chosenAgentMode(options: { readonly fleet?: boolean; readonly solo?: boolean }): AgentMode | undefined {
  if (options.fleet === true && options.solo === true) {
    throw new TrentError({ code: EXIT.USAGE, operation: "setup.options", message: "--solo and --team (--fleet) name two runners; pick one" });
  }
  return options.fleet === true ? "fleet" : options.solo === true ? "solo" : undefined;
}

/**
 * `agent.mode` for the config a setup run is about to write, and the lines that say so. The user's choice wins;
 * else a profile this run creates (no `config.yaml` yet) gets `NEW_PROFILE_AGENT_MODE`; else nothing is written and
 * the profile keeps what it has, so one without the key stays on the fleet. Called BEFORE the run saves.
 */
export function setupAgentMode(
  configManager: Pick<ConfigManager, "hasConfigFile" | "loadConfig">,
  chosen: AgentMode | undefined,
): { write: AgentMode | undefined; lines: string[] } {
  const isNewProfile = !configManager.hasConfigFile();
  const write = chosen ?? (isNewProfile ? NEW_PROFILE_AGENT_MODE : undefined);
  const why = chosen !== undefined ? "as chosen" : isNewProfile ? "a new profile" : "this profile's own, unchanged";
  return {
    write,
    lines: [`Agent mode: ${write ?? agentMode(configManager.loadConfig())} (${why})`, `  ${AGENT_MODE_LINES.solo}`, `  ${AGENT_MODE_LINES.fleet}`],
  };
}

/** The config with `agent.mode` set, or unchanged when there is nothing to write. */
export function withAgentMode(config: TrentConfig, mode: AgentMode | undefined): TrentConfig {
  return mode === undefined ? config : { ...config, agent: { ...config.agent, mode } };
}
