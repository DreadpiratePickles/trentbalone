import {
  DEFAULT_MODELS,
  detectProviderKeys,
  missingKeyGuidance,
  primaryEnvVar,
} from "./detect.js";
import { ALL_TOOLSETS, STARTER_AGENTS, applyToolsets, withFleet } from "./steps.js";
import { SetupRun } from "./SetupRun.js";
import type { SetupOptions, SetupResult } from "./types.js";
import type { Provider } from "../config/schema.js";

/**
 * Quick: use what is already here.
 *
 * It detects provider keys, shows what it found by NAME, asks for one confirmation, writes the
 * config and installs the three starter agents. There is deliberately no browser sign-in step: there
 * is no portal to sign into, so the failure path names the exact variable and the exact file instead
 * of miming an authorization flow.
 */
export class QuickSetup extends SetupRun {
  async execute(options: Partial<SetupOptions> = {}): Promise<SetupResult> {
    const { configManager, prompts, env } = this.ctx;

    if (options.apiKey && options.provider) {
      this.saveSecret(primaryEnvVar(options.provider), options.apiKey);
    }

    const detected = detectProviderKeys(configManager, env, options.provider);

    if (detected.length === 0) {
      for (const line of missingKeyGuidance(configManager)) this.say(line);
      return this.abort(
        "quick",
        options.provider
          ? `No key found for ${options.provider}. Set ${primaryEnvVar(options.provider)} in your environment or in ${configManager.getSecretsPath()}, then run setup again.`
          : `No provider key found. Set OPENAI_API_KEY (or another provider variable listed above) in your environment or in ${configManager.getSecretsPath()}, then run setup again.`,
      );
    }

    this.say("Found the following provider keys:");
    for (const key of detected) {
      this.say(`  ${key.provider}: ${key.envVar} (from your ${key.source})`);
    }

    const provider =
      detected.length === 1
        ? (detected[0] as (typeof detected)[number]).provider
        : await prompts.select<Provider>({
            id: "provider",
            message: "Which provider should Trent use by default?",
            choices: detected.map((d) => ({ name: `${d.provider} (${d.envVar})`, value: d.provider })),
            default: (detected[0] as (typeof detected)[number]).provider,
          });

    const model = options.model ?? DEFAULT_MODELS[provider];

    this.blank();
    this.say(`Provider: ${provider}`);
    this.say(`Model: ${model}`);
    this.say(`Toolsets: all ${ALL_TOOLSETS.length} enabled`);
    this.say(`Starter agents: ${STARTER_AGENTS.join(", ")}`);

    const proceed = await prompts.confirm({
      id: "confirm",
      message: "Write this configuration?",
      default: true,
    });

    if (!proceed) {
      return this.abort("quick", "Setup cancelled. No configuration was written.");
    }

    const base = { ...configManager.loadConfig(), provider, model };
    const config = withFleet(applyToolsets(base, ALL_TOOLSETS), STARTER_AGENTS);
    configManager.saveConfig(config);

    await this.doctor();

    return this.ok(
      "quick",
      `Quick setup complete. Provider ${provider}, model ${model}, ${STARTER_AGENTS.length} starter agents, config at ${configManager.getConfigPath()}.`,
      configManager.loadConfig(),
    );
  }
}

