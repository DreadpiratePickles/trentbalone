import {
  DEFAULT_MODELS,
  detectProviderKeys,
  missingKeyGuidance,
  primaryEnvVar,
} from "./detect.js";
import { ALL_TOOLSETS, STARTER_AGENTS, applyToolsets, withFleet } from "./steps.js";
import { mediaBackendPresent } from "../tools/media/backend.js";
import { ConnectStore } from "../connect/store.js";
import { BUSINESS_PROVIDERS } from "../tools/business/http.js";
import { SetupRun } from "./SetupRun.js";
import type { SetupOptions, SetupResult } from "./types.js";
import type { Provider } from "../config/schema.js";
import type { ConfigManager } from "../config/ConfigManager.js";

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
        "no-key",
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
    // [B2] `media` needs ffmpeg and ffprobe on PATH or the media image; without one it is written
    // off explicitly, so a later `trent update` cannot switch it on unasked (docs/media.md).
    const media = await (this.ctx.mediaBackendPresent ?? (() => mediaBackendPresent(env)))();
    // [B1] `social` executes nothing without a connected provider, so it is on only when
    // `trent connect meta|bluesky|buffer` has been run; the check reads names, never a value.
    const social = (this.ctx.socialProviderConnected ?? (() => socialProviderConnected(configManager)))();
    // [B3] `business` likewise: on only when `trent connect stripe|google|square|twilio` holds one.
    const business = (this.ctx.businessProviderConnected ?? (() => businessProviderConnected(configManager)))();
    // [P2-9] `a2a` reaches only the peers `a2a.peers` names, so with none it has nothing to talk to.
    const a2a = (configManager.loadConfig().a2a?.peers ?? []).length > 0;
    const toolsets = ALL_TOOLSETS.filter((t) => (t !== "media" || media) && (t !== "social" || social) && (t !== "business" || business) && (t !== "a2a" || a2a));
    const off = [
      ...(media ? [] : ["media is off because no ffmpeg/ffprobe or media image was found (docs/media.md)"]),
      ...(social ? [] : ["social is off because no social provider is connected; run trent connect meta, bluesky or buffer, then enable it (docs/social.md)"]),
      ...(business ? [] : ["business is off because no business provider is connected; run trent connect stripe, google, square or twilio, then enable it (docs/business.md)"]),
      ...(a2a ? [] : ["a2a is off because no A2A peer is configured; add one under a2a.peers, then enable it (docs/a2a.md)"]), // [P2-9]
    ];

    this.blank();
    this.say(`Provider: ${provider}`);
    this.say(`Model: ${model}`);
    this.say(off.length === 0 ? `Toolsets: all ${ALL_TOOLSETS.length} enabled` : `Toolsets: ${toolsets.length} of ${ALL_TOOLSETS.length} enabled; ${off.join("; ")}`);
    this.say(`Starter agents: ${STARTER_AGENTS.join(", ")}`);

    const proceed = await prompts.confirm({
      id: "confirm",
      message: "Write this configuration?",
      default: true,
    });

    if (!proceed) {
      return this.abort("quick", "Setup cancelled. No configuration was written.", "cancelled");
    }

    const base = { ...configManager.loadConfig(), provider, model };
    const config = withFleet(applyToolsets(base, toolsets), STARTER_AGENTS);
    configManager.saveConfig(config);

    await this.doctor();

    return this.ok(
      "quick",
      `Quick setup complete. Provider ${provider}, model ${model}, ${STARTER_AGENTS.length} starter agents, config at ${configManager.getConfigPath()}.`,
      configManager.loadConfig(),
    );
  }
}

/** True when any provider the social toolset publishes through is connected. Names only; no value is read. */
function socialProviderConnected(configManager: ConfigManager): boolean {
  const store = new ConnectStore(configManager);
  return (["meta", "bluesky", "buffer"] as const).some((id) => store.read(id).connected);
}

/** True when any provider the business toolset executes against is connected. Names only; no value is read. */
function businessProviderConnected(configManager: ConfigManager): boolean {
  const store = new ConnectStore(configManager);
  return BUSINESS_PROVIDERS.some((id) => store.read(id).connected);
}
