/**
 * The `hooks` group: what the user's hooks are, and the one place they are allowed to run.
 *
 * `list` reads `hooks` from `config.yaml` and says, per hook, whether this exact spec has been
 * consented to. `consent` records a hash of every hook currently in the config, replacing the
 * record rather than adding to it — so removing a hook from the config and running `consent`
 * revokes it, and editing a hook's argv, timeout or match filter loses its consent until the user
 * grants it again. A hook that is not in the record never runs (`@trent/core/hooks`).
 *
 * Nothing here executes a hook. Granting consent is a decision about future runs, and a command
 * that ran the hook to "check it" would be the one command in the group that needed consent
 * itself.
 */

import { EXIT, TrentError } from "@trent/core/errors/index.js";
import { consentPath, hookSpecHash, readConsent, writeConsent, HOOK_KINDS, type HookKind, type HookSpec } from "@trent/core/hooks/index.js";
import type { CommandSpec } from "../registry.js";
import type { CommandContext } from "../context.js";

interface ConfiguredHook {
  readonly kind: HookKind;
  readonly spec: HookSpec;
  readonly hash: string;
}

/** Every configured hook, in the fixed kind order, so two runs list the same hooks in the same order. */
function configured(ctx: CommandContext): ConfiguredHook[] {
  const config = ctx.config().loadConfig();
  const out: ConfiguredHook[] = [];
  for (const kind of HOOK_KINDS) {
    for (const spec of config.hooks?.[kind] ?? []) out.push({ kind, spec, hash: hookSpecHash(kind, spec) });
  }
  return out;
}

function describeHook(hook: ConfiguredHook, consented: ReadonlySet<string>): Record<string, unknown> {
  return {
    kind: hook.kind,
    command: [...hook.spec.command],
    consented: consented.has(hook.hash),
    hash: hook.hash,
    ...(hook.spec.timeout_ms === undefined ? {} : { timeout_ms: hook.spec.timeout_ms }),
    ...(hook.spec.match?.tool === undefined ? {} : { match_tool: hook.spec.match.tool }),
  };
}

/** `argv[0] argv[1] ...` for display only. Never re-parsed, never handed to a shell. */
function argvLine(command: readonly string[]): string {
  return command.join(" ");
}

export const hooksSpec: CommandSpec = {
  name: "hooks",
  description: "List the configured user hooks and record consent for them",
  subcommands: [
    {
      name: "list",
      description: "Show every configured hook and whether this exact spec has been consented to",
      run(ctx) {
        const hooks = configured(ctx);
        const consented = new Set(readConsent(ctx.config().getProfileDir()).consented);
        const described = hooks.map((hook) => describeHook(hook, consented));
        return {
          data: {
            profile: ctx.config().getProfile(),
            consentFile: consentPath(ctx.config().getProfileDir()),
            hooks: described,
            consented: described.filter((hook) => hook.consented === true).length,
            unconsented: described.filter((hook) => hook.consented !== true).length,
          },
        };
      },
      render(data, ctx) {
        const d = data as unknown as { consentFile: string; hooks: ReturnType<typeof describeHook>[]; consented: number; unconsented: number };
        const lines = [ctx.theme.emphasis("USER HOOKS"), `  ${ctx.theme.body("consent record")} ${ctx.theme.value(d.consentFile)}`];
        if (d.hooks.length === 0) {
          lines.push(`  ${ctx.theme.meta("no hooks configured; add a hooks block to config.yaml (docs/configuration.md)")}`);
          return lines;
        }
        for (const hook of d.hooks) {
          const state = hook.consented === true ? "consented" : "not consented; this hook will not run";
          lines.push(`  ${ctx.theme.body(String(hook.kind))} ${ctx.theme.value(argvLine(hook.command as string[]))}`);
          const filter = hook.match_tool === undefined ? "" : ` on tool ${String(hook.match_tool)}`;
          const timeout = hook.timeout_ms === undefined ? "" : ` timeout ${String(hook.timeout_ms)}ms`;
          lines.push(`    ${ctx.theme.meta(`${state}${filter}${timeout}`)}`);
        }
        lines.push(`  ${ctx.theme.body("totals")} ${ctx.theme.value(`${d.consented} consented, ${d.unconsented} not`)}`);
        return lines;
      },
    },
    {
      name: "consent",
      description: "Record consent for exactly the hooks currently in config.yaml, replacing the record",
      run(ctx) {
        const hooks = configured(ctx);
        const profileDir = ctx.config().getProfileDir();
        const file = consentPath(profileDir);
        const before = new Set(readConsent(profileDir).consented);
        const wanted = hooks.map((hook) => hook.hash);
        const revoked = [...before].filter((hash) => !wanted.includes(hash)).length;
        const listed = hooks.map((hook) => ({ kind: hook.kind, command: [...hook.spec.command] }));

        // A dry run reports; it does not judge. "Nothing would be consented" is a true report, and
        // it is also what the registry invariant asks of every command with no config on disk.
        if (ctx.dryRun) return { data: { dryRun: true, command: "hooks consent", consentFile: file, granted: wanted.length, revoked, hooks: listed } };

        if (hooks.length === 0) {
          throw new TrentError({
            code: EXIT.CONFIG,
            operation: "hooks.consent",
            message: "there are no hooks in config.yaml to consent to; add a hooks block first (docs/configuration.md)",
            target: ctx.config().getConfigPath(),
          });
        }
        writeConsent(profileDir, wanted);
        return { data: { consentFile: file, granted: wanted.length, revoked, hooks: listed } };
      },
      render(data, ctx) {
        const d = data as unknown as { dryRun?: boolean; consentFile: string; granted: number; revoked: number; hooks: { kind: string; command: string[] }[] };
        const verb = d.dryRun === true ? "would consent to" : "consented to";
        const lines = [ctx.theme.emphasis("HOOK CONSENT"), `  ${ctx.theme.body("record")} ${ctx.theme.value(d.consentFile)}`];
        for (const hook of d.hooks) lines.push(`  ${ctx.theme.body(hook.kind)} ${ctx.theme.value(argvLine(hook.command))}`);
        lines.push(`  ${ctx.theme.meta(`${verb} ${d.granted} hook(s); ${d.revoked} earlier consent(s) dropped`)}`);
        return lines;
      },
    },
  ],
};
