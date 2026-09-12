/**
 * `model`, `tools` and the `config` group.
 *
 * These are the commands that used to print canned text. Every one of them now reads or writes the
 * real profile through `ConfigManager`. `config get` on a secret reports presence, never the value.
 */

import { isSecretKey, toSecretName } from "@trent/core/config/index.js";
import { EXIT, TrentError } from "@trent/core/errors/index.js";
import type { CommandSpec } from "../registry.js";

export const modelSpec: CommandSpec = {
  name: "model [name]",
  description: "Show or change the active model and provider",
  options: [{ flags: "--provider <provider>", description: "Model provider" }],
  run(ctx, opts, args) {
    const name = args[0];
    const provider = typeof opts.provider === "string" ? opts.provider : undefined;

    if (ctx.dryRun) {
      return {
        data: {
          dryRun: true,
          command: "model",
          wouldSet: { model: name ?? null, provider: provider ?? null },
        },
      };
    }

    const config = ctx.config().loadConfig();
    if (provider === undefined && name === undefined) {
      return { data: { provider: config.provider, model: config.model, changed: false } };
    }

    if (provider !== undefined) config.provider = provider as typeof config.provider;
    if (name !== undefined) config.model = name;
    ctx.config().saveConfig(config);
    return { data: { provider: config.provider, model: config.model, changed: true } };
  },
  render(data, ctx) {
    const d = data as { provider?: string; model?: string; dryRun?: boolean };
    if (d.dryRun === true) return [`  ${ctx.theme.meta("dry run")} ${JSON.stringify(data)}`];
    return [
      `  ${ctx.theme.meta("provider")} ${ctx.theme.value(String(d.provider))}`,
      `  ${ctx.theme.meta("model")}    ${ctx.theme.value(String(d.model))}`,
    ];
  },
};

export const toolsSpec: CommandSpec = {
  name: "tools",
  description: "List and toggle the active toolsets",
  options: [
    { flags: "--enable <toolset>", description: "Enable a toolset" },
    { flags: "--disable <toolset>", description: "Disable a toolset" },
  ],
  run(ctx, opts) {
    const enable = typeof opts.enable === "string" ? opts.enable : undefined;
    const disable = typeof opts.disable === "string" ? opts.disable : undefined;

    if (ctx.dryRun) {
      return {
        data: { dryRun: true, command: "tools", wouldEnable: enable ?? null, wouldDisable: disable ?? null },
      };
    }

    const config = ctx.config().loadConfig();
    let changed = false;

    if (enable !== undefined) {
      config.disabled_toolsets = config.disabled_toolsets.filter((t) => t !== enable);
      if (!config.toolsets.includes(enable as (typeof config.toolsets)[number])) {
        config.toolsets = [...config.toolsets, enable as (typeof config.toolsets)[number]];
      }
      changed = true;
    }
    if (disable !== undefined) {
      config.toolsets = config.toolsets.filter((t) => t !== disable);
      if (!config.disabled_toolsets.includes(disable as (typeof config.disabled_toolsets)[number])) {
        config.disabled_toolsets = [
          ...config.disabled_toolsets,
          disable as (typeof config.disabled_toolsets)[number],
        ];
      }
      changed = true;
    }
    if (changed) ctx.config().saveConfig(config);

    return {
      data: { enabled: config.toolsets, disabled: config.disabled_toolsets, changed },
    };
  },
  render(data, ctx) {
    const d = data as { enabled?: string[]; disabled?: string[]; dryRun?: boolean };
    if (d.dryRun === true) return [`  ${ctx.theme.meta("dry run")} ${JSON.stringify(data)}`];
    const lines = [ctx.theme.emphasis("TOOLSETS")];
    for (const t of d.enabled ?? []) lines.push(`  ${ctx.theme.success("on ")} ${ctx.theme.value(t)}`);
    for (const t of d.disabled ?? []) lines.push(`  ${ctx.theme.meta("off")} ${ctx.theme.meta(t)}`);
    return lines;
  },
};

function describeKey(key: string): { secret: boolean; name: string } {
  return isSecretKey(key) ? { secret: true, name: toSecretName(key) } : { secret: false, name: key };
}

export const configSpec: CommandSpec = {
  name: "config",
  description: "Read and write configuration values for the active profile",
  subcommands: [
    {
      name: "get <key>",
      description: "Read a configuration value (a secret reports presence, never its value)",
      run(ctx, _opts, args) {
        const key = String(args[0]);
        const { secret, name } = describeKey(key);
        if (ctx.dryRun) {
          return { data: { dryRun: true, command: "config get", key, secret } };
        }
        const value = ctx.config().get(key);
        if (secret) {
          // A credential never reaches stdout, a log or a transcript. Presence only.
          return { data: { key: name, secret: true, present: value !== undefined && value !== "" } };
        }
        return { data: { key, secret: false, value: value ?? null } };
      },
      render(data, ctx) {
        const d = data as { key: string; secret: boolean; value?: unknown; present?: boolean };
        const shown = d.secret ? (d.present === true ? "[set]" : "[unset]") : JSON.stringify(d.value);
        return [`  ${ctx.theme.meta(d.key)} ${ctx.theme.value(String(shown))}`];
      },
    },
    {
      name: "set <key> <value>",
      description: "Write a configuration value (secret keys go to the profile secrets file)",
      run(ctx, _opts, args) {
        const key = String(args[0]);
        const raw = String(args[1]);
        const { secret, name } = describeKey(key);
        if (ctx.dryRun) {
          return { data: { dryRun: true, command: "config set", key: name, secret } };
        }
        ctx.config().set(key, raw);
        // Echo the key, never the value.
        return { data: { key: name, secret, written: true } };
      },
      render(data, ctx) {
        const d = data as { key: string; secret: boolean };
        return [
          `  ${ctx.theme.success("set")} ${ctx.theme.value(d.key)}${
            d.secret ? ` ${ctx.theme.meta("(secret, value not echoed)")}` : ""
          }`,
        ];
      },
    },
    {
      name: "unset <key>",
      description: "Remove a configuration value",
      run(ctx, _opts, args) {
        const key = String(args[0]);
        const { secret, name } = describeKey(key);
        if (ctx.dryRun) {
          return { data: { dryRun: true, command: "config unset", key: name, secret } };
        }
        ctx.config().delete(key);
        return { data: { key: name, secret, removed: true } };
      },
      render(data, ctx) {
        const d = data as { key: string };
        return [`  ${ctx.theme.success("unset")} ${ctx.theme.value(d.key)}`];
      },
    },
    {
      name: "list",
      description: "List the profiles available on this machine",
      run(ctx) {
        const manager = ctx.config();
        return {
          data: {
            active: manager.getProfile(),
            baseDir: manager.getBaseDir(),
            profiles: manager.listProfiles(),
            configExists: manager.exists(),
          },
        };
      },
      render(data, ctx) {
        const d = data as { active: string; profiles: string[]; baseDir: string };
        return [
          `  ${ctx.theme.meta("base dir")} ${ctx.theme.value(d.baseDir)}`,
          `  ${ctx.theme.meta("active")}   ${ctx.theme.value(d.active)}`,
          ...d.profiles.map((p) => `    ${ctx.theme.body(p)}`),
        ];
      },
    },
  ],
};

/** Shared usage failure for a command given an argument it cannot use. */
export function usageError(operation: string, message: string, target?: string): TrentError {
  return new TrentError({
    code: EXIT.USAGE,
    operation,
    message,
    ...(target === undefined ? {} : { target }),
  });
}
