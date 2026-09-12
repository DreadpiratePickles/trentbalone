import { ProviderSchema, ToolsetSchema } from "../config/schema.js";
import type { Provider, Toolset, TrentConfig } from "../config/schema.js";
import type { Choice } from "./ports.js";

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
