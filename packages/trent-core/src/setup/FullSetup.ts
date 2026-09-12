import { DEFAULT_MODELS, hasKeyFor, primaryEnvVar } from "./detect.js";
import { centsToDollars, dollarsToCents } from "./money.js";
import {
  applyToolsets,
  parseAgentList,
  providerChoices,
  toolsetChoices,
  withBudget,
  withFleet,
} from "./steps.js";
import { SetupRun } from "./SetupRun.js";
import type { Provider, Toolset } from "../config/schema.js";
import type { SetupOptions, SetupResult } from "./types.js";

/**
 * Full: walk provider, model, toolsets, agents and budget.
 *
 * Every question is pre-filled from the CURRENT config, so a returning user presses enter through the
 * whole wizard and lands on exactly the configuration they already had. The `default` field is
 * mandatory on the prompt port, so a step that forgot to pre-fill cannot compile, and the scripted
 * adapter throws if one ever slips through at runtime.
 */
export class FullSetup extends SetupRun {
  async execute(options: Partial<SetupOptions> = {}): Promise<SetupResult> {
    const { configManager, prompts } = this.ctx;
    const current = configManager.loadConfig();

    const provider =
      options.provider ??
      (await prompts.select<Provider>({
        id: "provider",
        message: "Model provider",
        choices: providerChoices(),
        default: current.provider,
      }));

    const modelDefault =
      current.provider === provider ? current.model : DEFAULT_MODELS[provider];
    const model =
      options.model ??
      (await prompts.input({ id: "model", message: "Model", default: modelDefault }));

    const toolsets =
      options.toolsets ??
      (await prompts.checkbox<Toolset>({
        id: "toolsets",
        message: "Toolsets to enable (everything unchecked is written to the disabled list)",
        choices: toolsetChoices(),
        default: current.toolsets,
      }));

    const agents =
      options.agents ??
      parseAgentList(
        await prompts.input({
          id: "agents",
          message: "Agents to install (comma separated)",
          default: current.fleet.installed_agents.join(", "),
        }),
        current.fleet.installed_agents,
      );

    const dailyCents =
      options.dailyBudgetCents ??
      dollarsToCents(
        await prompts.input({
          id: "daily_budget",
          message: "Daily spend cap in USD",
          default: centsToDollars(current.budget.daily_cap),
        }),
      );

    const perRunCents =
      options.perRunCapCents ??
      dollarsToCents(
        await prompts.input({
          id: "per_run_budget",
          message: "Per-run spend cap in USD",
          default: centsToDollars(current.budget.per_run_cap),
        }),
      );

    await this.ensureKey(provider, options.apiKey);

    this.blank();
    this.say(`Provider: ${provider}`);
    this.say(`Model: ${model}`);
    this.say(`Toolsets: ${toolsets.join(", ") || "none"}`);
    this.say(`Agents: ${agents.join(", ")}`);
    this.say(`Daily cap: ${dailyCents} cents (USD ${centsToDollars(dailyCents)})`);
    this.say(`Per-run cap: ${perRunCents} cents (USD ${centsToDollars(perRunCents)})`);

    const proceed = await prompts.confirm({
      id: "confirm",
      message: "Write this configuration?",
      default: true,
    });
    if (!proceed) return this.abort("full", "Setup cancelled. No configuration was written.");

    const base = { ...current, provider, model };
    const config = withBudget(
      withFleet(applyToolsets(base, toolsets), agents),
      dailyCents,
      perRunCents,
    );
    configManager.saveConfig(config);

    await this.doctor();

    return this.ok(
      "full",
      `Full setup complete. Provider ${provider}, model ${model}, ${toolsets.length} toolsets, ${agents.length} agents, daily cap ${dailyCents} cents. Config at ${configManager.getConfigPath()}.`,
      configManager.loadConfig(),
    );
  }

  /**
   * If the chosen provider has no key yet, offer to store one. The value goes to the profile `.env`
   * through a masked prompt and is never printed, returned in a message, or written to `config.yaml`.
   */
  private async ensureKey(provider: Provider, supplied?: string): Promise<void> {
    const { configManager, prompts, env } = this.ctx;
    const name = primaryEnvVar(provider);

    if (supplied) {
      this.saveSecret(name, supplied);
      return;
    }
    if (hasKeyFor(configManager, env, provider)) {
      this.say(`${name} is already set. Leaving it as it is.`);
      return;
    }

    this.say(`No ${name} was found in your environment or in ${configManager.getSecretsPath()}.`);
    const enterNow = await prompts.confirm({
      id: "api_key_entry",
      message: `Enter a value for ${name} now? It is written only to the profile env file.`,
      default: false,
    });
    if (!enterNow) {
      this.say(`Set ${name} before your first run, or Trent cannot reach ${provider}.`);
      return;
    }

    const value = await prompts.password({ id: "api_key", message: `${name} (input hidden)` });
    if (value.trim() === "") {
      this.say(`No value entered. ${name} is still unset.`);
      return;
    }
    this.saveSecret(name, value);
  }
}
