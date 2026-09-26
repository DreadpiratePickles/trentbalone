import os from "node:os";
import {
  DEFAULT_MODELS,
  LOCAL_SETUP_COMMAND, // [C9]
  describeKeylessLocal, // [C9]
  detectProviderKeys,
  findKeylessLocal, // [C9]
  missingKeyGuidance,
  primaryEnvVar,
} from "./detect.js";
import { ALL_TOOLSETS, STARTER_AGENTS, applyToolsets, chosenAgentMode, setupAgentMode, withAgentMode, withFleet } from "./steps.js"; // [C11.2] the agent mode
import { mediaBackendPresent } from "../tools/media/backend.js";
import { ConnectStore } from "../connect/store.js";
import { BUSINESS_PROVIDERS } from "../tools/business/http.js";
import { SetupRun } from "./SetupRun.js";
import { createLocalRuntime, isLocalProvider } from "./local-runtime.js";
import { resolveLocalModel } from "./local-setup.js";
import type { SetupContext, SetupOptions, SetupResult } from "./types.js";
import type { Provider, Toolset } from "../config/schema.js";
import type { ConfigManager } from "../config/ConfigManager.js";
import type { AgentMode } from "../config/sections/agent.js"; // [C11.2]

/**
 * Quick: use what is already here.
 *
 * It detects provider keys, shows what it found by NAME, asks for one confirmation, writes the
 * config and installs the three starter agents. There is deliberately no browser sign-in step: there
 * is no portal to sign into, so the failure path names the exact variable and the exact file instead
 * of miming an authorization flow.
 */
export class QuickSetup extends SetupRun {
  private chosenMode: AgentMode | undefined; // [C11.2] `--team`/`--fleet` or `--solo`, read once before anything runs

  async execute(options: Partial<SetupOptions> = {}): Promise<SetupResult> {
    const { configManager, prompts, env } = this.ctx;
    this.chosenMode = chosenAgentMode(options); // [C11.2]

    if (options.apiKey && options.provider) {
      this.saveSecret(primaryEnvVar(options.provider), options.apiKey);
    }

    // [L0-3] G3: a local runtime has no key to find; it has a runtime to reach and a model to pull.
    if (isLocalProvider(options.provider)) {
      const local = await resolveLocalModel({
        provider: options.provider,
        ...(options.model === undefined ? {} : { requested: options.model }),
        ...(options.pull === undefined ? {} : { pull: options.pull }),
        env,
        runtime: this.ctx.localRuntime ?? createLocalRuntime(),
        totalMemoryBytes: this.ctx.totalMemoryBytes ?? os.totalmem(),
        prompts,
        say: (line) => this.say(line),
      });
      if (!local.ok) return this.abort("quick", local.message, local.reason);
      return await this.finish(options.provider, local.model, [`What to expect: ${local.expectation}`]);
    }

    const detected = detectProviderKeys(configManager, env, options.provider);

    if (detected.length === 0) {
      // [C9] No key and no provider named: a model already on this machine may need none. The check is
      // local setup's own (L2), so the command suggested is one that then works.
      const local = options.provider === undefined
        ? await findKeylessLocal({ env, ...(this.ctx.localDiscovery === undefined ? {} : { discovery: this.ctx.localDiscovery }), ...(this.ctx.totalMemoryBytes === undefined ? {} : { totalMemoryBytes: this.ctx.totalMemoryBytes }) })
        : undefined;
      for (const line of missingKeyGuidance(configManager, local)) this.say(line);
      const stopped = this.abort(
        "quick",
        options.provider
          ? `No key found for ${options.provider}. Set ${primaryEnvVar(options.provider)} in your environment or in ${configManager.getSecretsPath()}, then run setup again.`
          : local !== undefined // [C9]
            ? `No provider key found, but ${describeKeylessLocal(local)}, which needs no key. Run: ${LOCAL_SETUP_COMMAND} (or set OPENAI_API_KEY or another provider variable listed above in your environment or in ${configManager.getSecretsPath()}, then run setup again).`
            : `No provider key found. Set OPENAI_API_KEY (or another provider variable listed above) in your environment or in ${configManager.getSecretsPath()}, then run setup again.`,
        "no-key",
      );
      return local === undefined ? stopped : { ...stopped, suggested: "local" }; // [C9]
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

    return await this.finish(provider, options.model ?? DEFAULT_MODELS[provider]);
  }

  /** The part every quick path shares: toolsets, the summary, one confirmation, the write. */
  private async finish(provider: Provider, model: string, notes: readonly string[] = []): Promise<SetupResult> {
    const { configManager, prompts } = this.ctx;
    const { toolsets, line } = await quickToolsets(this.ctx); // [L2] shared with local mode
    const mode = setupAgentMode(configManager, this.chosenMode); // [C11.2] solo into a profile this run creates

    this.blank();
    this.say(`Provider: ${provider}`);
    this.say(`Model: ${model}`);
    this.say(line);
    this.say(`Starter agents: ${STARTER_AGENTS.join(", ")}`);
    for (const modeLine of mode.lines) this.say(modeLine); // [C11.2] the two modes, one line each
    for (const note of notes) this.say(note);

    const proceed = await prompts.confirm({
      id: "confirm",
      message: "Write this configuration?",
      default: true,
    });

    if (!proceed) {
      return this.abort("quick", "Setup cancelled. No configuration was written.", "cancelled");
    }

    const base = { ...configManager.loadConfig(), provider, model };
    const config = withAgentMode(withFleet(applyToolsets(base, toolsets), STARTER_AGENTS), mode.write); // [C11.2]
    configManager.saveConfig(config);

    await this.doctor();

    return this.ok(
      "quick",
      `Quick setup complete. Provider ${provider}, model ${model}, ${STARTER_AGENTS.length} starter agents, config at ${configManager.getConfigPath()}.`,
      configManager.loadConfig(),
    );
  }
}

/**
 * The toolsets a quick run turns on: every one, less those with nothing behind them on this machine,
 * each named with why. [L2] Moved out of `finish` unchanged so local mode writes the same toolsets.
 */
export async function quickToolsets(ctx: SetupContext): Promise<{ toolsets: Toolset[]; line: string }> {
  const { configManager, env } = ctx;
  // [B2] `media` needs ffmpeg and ffprobe on PATH or the media image; without one it is written
  // off explicitly, so a later `trent update` cannot switch it on unasked (docs/media.md).
  const media = await (ctx.mediaBackendPresent ?? (() => mediaBackendPresent(env)))();
  // [B1] `social` executes nothing without a connected provider, so it is on only when
  // `trent connect meta|bluesky|buffer` has been run; the check reads names, never a value.
  const social = (ctx.socialProviderConnected ?? (() => socialProviderConnected(configManager)))();
  // [B3] `business` likewise: on only when `trent connect stripe|google|square|twilio` holds one.
  const business = (ctx.businessProviderConnected ?? (() => businessProviderConnected(configManager)))();
  // [P2-9] `a2a` reaches only the peers `a2a.peers` names, so with none it has nothing to talk to.
  const a2a = (configManager.loadConfig().a2a?.peers ?? []).length > 0;
  const toolsets = ALL_TOOLSETS.filter((t) => (t !== "media" || media) && (t !== "social" || social) && (t !== "business" || business) && (t !== "a2a" || a2a));
  const off = [
    ...(media ? [] : ["media is off because no ffmpeg/ffprobe or media image was found (docs/media.md)"]),
    ...(social ? [] : ["social is off because no social provider is connected; run trent connect meta, bluesky or buffer, then enable it (docs/social.md)"]),
    ...(business ? [] : ["business is off because no business provider is connected; run trent connect stripe, google, square or twilio, then enable it (docs/business.md)"]),
    ...(a2a ? [] : ["a2a is off because no A2A peer is configured; add one under a2a.peers, then enable it (docs/a2a.md)"]), // [P2-9]
  ];

  return {
    toolsets,
    line: off.length === 0 ? `Toolsets: all ${ALL_TOOLSETS.length} enabled` : `Toolsets: ${toolsets.length} of ${ALL_TOOLSETS.length} enabled; ${off.join("; ")}`,
  };
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
