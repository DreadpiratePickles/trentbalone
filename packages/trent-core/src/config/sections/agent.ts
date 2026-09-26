// [S1] solo
/**
 * The `agent` block of `config.yaml`: the X5 block (`orchestrator/recovery-config-schema.ts`,
 * `auto_recovery_cycles`), extended with `mode`, never replaced.
 *
 * `mode` picks the runner a surface starts: `fleet`, the planner and the seats (the shipped
 * behaviour), or `solo`, one agent with one tool loop and no seats (`solo/runner.ts`,
 * 02_plan/output/solo-harness-design-2026-09-26.md). Like `auto_recovery_cycles`, it has NO schema
 * default: the block stays a passthrough because the setup wizard writes `agent.disabled_toolsets`
 * into it, and a defaulted key would be written into every profile the config writer touches.
 * A profile without the key is `fleet`, and `agentMode` is the one place that says so.
 */
import { z } from "zod";
import { RecoveryConfigSchema } from "../../orchestrator/recovery-config-schema.js";

export const AGENT_MODES = ["fleet", "solo"] as const;
export type AgentMode = (typeof AGENT_MODES)[number];

/** What a profile without `agent.mode` runs. */
export const DEFAULT_AGENT_MODE: AgentMode = "fleet";

export const AgentConfigSchema = RecoveryConfigSchema.extend({
  /** `fleet` (default) or `solo`; absent means `fleet`. */
  mode: z.enum(AGENT_MODES).optional(),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

/** The runner a parsed config asks for. */
export function agentMode(config: { readonly agent?: { readonly mode?: AgentMode } }): AgentMode {
  return config.agent?.mode ?? DEFAULT_AGENT_MODE;
}
