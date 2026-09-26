import os from "node:os";
import { DEFAULT_MODELS, primaryEnvVar } from "./detect.js";
import { FullSetup } from "./FullSetup.js";
import { MINIMAL_TOOLSETS, applyToolsets, providerChoices, withFleet } from "./steps.js";
import { SetupRun } from "./SetupRun.js";
import { isLocalProvider } from "./local-runtime.js";
import { localModelDefault } from "./local-setup.js";
import type { Provider } from "../config/schema.js";
import type { SetupOptions, SetupResult } from "./types.js";

/**
 * Blank Slate: provider, model, `file_ops` and `terminal`. Nothing else.
 *
 * The important part is what it writes DOWN rather than what it leaves out. `platform_toolsets.cli`
 * and `agent.disabled_toolsets` are both written explicitly so that a later `trent update` reading
 * either one cannot re-enable a toolset the user never asked for. A config that lists only what is on
 * gives a future release permission to turn on whatever it adds next.
 *
 * The walkthrough is offered afterwards and is opt-in, never assumed.
 */
export class BlankSlate extends SetupRun {
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

    // [L0-3] A local provider is pre-filled with its tier's model, never the static table's.
    const modelDefault =
      current.provider === provider
        ? current.model
        : isLocalProvider(provider)
          ? localModelDefault(provider, this.ctx.totalMemoryBytes ?? os.totalmem())
          : DEFAULT_MODELS[provider];
    const model =
      options.model ??
      (await prompts.input({ id: "model", message: "Model", default: modelDefault }));

    if (options.apiKey) this.saveSecret(primaryEnvVar(provider), options.apiKey);

    const base = { ...current, provider, model };
    const config = withFleet(applyToolsets(base, MINIMAL_TOOLSETS), ["ceo"]);
    configManager.saveConfig(config);

    this.say(`Provider: ${provider}`);
    this.say(`Model: ${model}`);
    this.say(`Enabled toolsets: ${MINIMAL_TOOLSETS.join(", ")}`);
    this.say(
      `Explicitly disabled: ${config.disabled_toolsets.join(", ")} (written to disabled_toolsets, agent.disabled_toolsets and platform_toolsets.cli)`,
    );
    this.say(`Config at ${configManager.getConfigPath()}.`);

    const walkthrough = await prompts.confirm({
      id: "walkthrough",
      message: "Walk through the full setup now to add toolsets, agents and budgets?",
      default: false,
    });

    if (walkthrough) {
      this.say("Starting the full walkthrough. Press enter to keep any current value.");
      const full = await new FullSetup(this.ctx).execute({ mode: "full" });
      for (const line of full.output) this.lines.push(line);
      return {
        ...full,
        mode: "blank-slate",
        secretsConfigured: [...new Set([...this.secretsConfigured, ...full.secretsConfigured])],
        output: [...this.lines],
      };
    }

    await this.doctor();

    return this.ok(
      "blank-slate",
      `Blank Slate configured. Provider ${provider}, model ${model}, ${MINIMAL_TOOLSETS.length} toolsets enabled, ${config.disabled_toolsets.length} explicitly disabled.`,
      configManager.loadConfig(),
    );
  }
}
