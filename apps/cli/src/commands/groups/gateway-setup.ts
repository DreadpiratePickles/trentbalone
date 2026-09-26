/**
 * [P3] `trent gateway setup <platform>`: writes the names the platform's adapter actually reads,
 * taken from the registry (`@trent/core/gateway/registry.ts`), into the profile's `.env`. It used to
 * write `<PLATFORM>_BOT_TOKEN`, which Telegram, Discord, Slack and Mattermost read and the other
 * eight never do (Matrix reads MATRIX_ACCESS_TOKEN, LINE LINE_CHANNEL_ACCESS_TOKEN, ntfy NTFY_TOPIC).
 *
 * `--token` goes to the platform's one token name (`tokenSecret`); `--set NAME=value` to any other
 * name the platform reads, and a name it does not read is refused. Everything lands in `.env`
 * through `saveSecrets`, because the adapters read every setting there (`readSetting`), URLs and
 * topics included; `ConfigManager.set` would put a name without a secret-like suffix in config.yaml.
 * The reply names what was written and which required names are still missing, never a value.
 */
import type { ConfigManager } from "@trent/core/config/index.js";
import { EXIT, TrentError, type ExitCode } from "@trent/core/errors/index.js";
import { PLATFORM_REGISTRY, listPlatformIds, platformSecretNames } from "@trent/core/gateway/index.js";
import type { CommandSpec } from "../registry.js";

interface SetupPlan {
  readonly secrets: Record<string, string>;
  readonly refusal?: TrentError;
}

/** The names and values `--token` and `--set` map to, and the first reason to refuse, if any. */
function setupPlan(platform: string, opts: Record<string, unknown>): SetupPlan {
  const refuse = (code: ExitCode, message: string): TrentError => new TrentError({ code, operation: "gateway.setup", message, target: platform });
  const entry = PLATFORM_REGISTRY[platform];
  if (entry === undefined) return { secrets: {}, refusal: refuse(EXIT.USAGE, `unknown platform ${platform}; known: ${listPlatformIds().join(", ")}`) };
  const names = platformSecretNames(platform);
  const secrets: Record<string, string> = {};
  let refusal: TrentError | undefined;
  const put = (name: string, value: string): void => {
    // A line break would write a second NAME=value line into .env.
    if (/[\r\n]/.test(value)) refusal ??= refuse(EXIT.USAGE, `the value for ${name} contains a line break`);
    else secrets[name] = value;
  };
  if (typeof opts.token === "string" && opts.token !== "") {
    if (entry.tokenSecret === undefined) refusal ??= refuse(EXIT.USAGE, `${platform} has no single token; pass --set ${entry.requiredSecrets[0] ?? "NAME"}=<value> for each of: ${names.join(", ")}`);
    else put(entry.tokenSecret, opts.token);
  }
  for (const pair of Array.isArray(opts.set) ? opts.set.map(String) : []) {
    const at = pair.indexOf("=");
    const name = at > 0 ? pair.slice(0, at) : "(no name)";
    if (at <= 0 || at === pair.length - 1) refusal ??= refuse(EXIT.USAGE, `--set takes NAME=value; ${name} has none`);
    else if (!names.includes(name)) refusal ??= refuse(EXIT.USAGE, `${platform} does not read ${name}; it reads: ${names.join(", ")}`);
    else put(name, pair.slice(at + 1));
  }
  if (refusal === undefined && Object.keys(secrets).length === 0) {
    refusal = refuse(EXIT.AUTH, `--token or --set NAME=value is required to configure ${platform}; it reads: ${names.join(", ")}`);
  }
  return { secrets, ...(refusal === undefined ? {} : { refusal }) };
}

/** Required names with no value in `.env` or the environment, the two places an adapter reads. */
function missingNames(configManager: ConfigManager, platform: string): string[] {
  const saved = configManager.loadSecrets() as Record<string, unknown>;
  const present = (name: string): boolean => (typeof saved[name] === "string" && saved[name] !== "") || (process.env[name] ?? "") !== "";
  return (PLATFORM_REGISTRY[platform]?.requiredSecrets ?? []).filter((name) => !present(name));
}

export const gatewaySetupSpec: CommandSpec = {
  name: "setup <platform>",
  description: "Store a messaging platform's settings in the profile secrets file, under the names its adapter reads",
  options: [
    { flags: "--token <token>", description: "The platform's token, stored under the name its adapter reads; never echoed" },
    { flags: "--set <pairs...>", description: "NAME=value for any other name the platform reads (e.g. MATRIX_HOMESERVER_URL=https://...); never echoed" },
  ],
  run(ctx, opts, args) {
    const platform = String(args[0]);
    const plan = setupPlan(platform, opts);
    // Under --dry-run: the names the flags map to, and nothing read, written or refused.
    if (ctx.dryRun) return { data: { dryRun: true, command: "gateway setup", platform, wouldWriteSecrets: Object.keys(plan.secrets), reads: platformSecretNames(platform) } };
    if (plan.refusal !== undefined) throw plan.refusal;
    ctx.config().saveSecrets(plan.secrets);
    // The names of the secrets, never a value.
    return { data: { platform, secretsConfigured: Object.keys(plan.secrets), missing: missingNames(ctx.config(), platform) } };
  },
  render(data, ctx) {
    const d = data as { platform: string; secretsConfigured?: string[]; missing?: string[] };
    const lines = [`  ${ctx.theme.success("configured")} ${ctx.theme.value(d.platform)} ${ctx.theme.meta((d.secretsConfigured ?? []).join(", "))}`];
    for (const name of d.missing ?? []) lines.push(`  ${ctx.theme.meta("still needed:")} ${ctx.theme.value(name)} ${ctx.theme.meta(`(trent gateway setup ${d.platform} --set ${name}=<value>)`)}`);
    return lines;
  },
};
