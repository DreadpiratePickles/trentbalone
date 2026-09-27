/**
 * D15 — `trent security preset [paranoid|standard]`.
 *
 * The operator's one-command posture switch. `paranoid` is the hard posture, `standard` the
 * documented default; both are bundles of config keys the gate chain already honours
 * (`@trent/core/config/security-presets.ts` names every key and why). Applying one writes through
 * the ordinary `ConfigManager.saveConfig` path, prints the diff, and grades the profile before and
 * after with the same `auditProfileSecurity` + `gradeSecurity` that `trent security status` runs.
 * With no argument it shows the active preset and what each would change, and writes nothing.
 *
 * Operator-only by construction: the `lower-trents-own-guardrails` hardline rule
 * (`governance/hardline.ts`) refuses `trent security preset` from any tool call, at every level.
 */
import process from "node:process";
import { EXIT, TrentError } from "@trent/core/errors/index.js";
import type { TrentConfig } from "@trent/core/config/schema.js";
import {
  SECURITY_PRESET_DESCRIPTIONS,
  SECURITY_PRESET_NAMES,
  SECURITY_PRESET_UNAVAILABLE,
  applySecurityPreset,
  isSecurityPresetName,
  matchSecurityPreset,
  type SecurityPresetChange,
  type SecurityPresetUnavailable,
} from "@trent/core/config/security-presets.js";
import { auditProfileSecurity } from "@trent/core/governance/security-audit.js";
import { gradeSecurity } from "@trent/core/governance/security-grade.js";
import type { CommandContext } from "../context.js";
import type { CommandSpec } from "../registry.js";

interface GradeSnapshot {
  readonly grade: string;
  readonly score: number;
}

/** `trent security preset <name>`: the stable `--json` shape. */
interface ApplyData {
  readonly kind: "apply";
  readonly command: "security preset";
  readonly preset: string;
  readonly dryRun: boolean;
  readonly written: boolean;
  readonly activeBefore: string;
  readonly activeAfter: string;
  readonly changes: readonly SecurityPresetChange[];
  readonly grade: { readonly before: GradeSnapshot; readonly after: GradeSnapshot };
  readonly unavailable: readonly SecurityPresetUnavailable[];
}

/** `trent security preset` (no argument): the stable `--json` shape. */
interface ShowData {
  readonly kind: "show";
  readonly command: "security preset";
  readonly active: string;
  readonly presets: ReadonlyArray<{ name: string; description: string; changes: readonly SecurityPresetChange[] }>;
  readonly unavailable: readonly SecurityPresetUnavailable[];
}

/** The grade the profile would have with `config`: the same audit and rubric `security status` uses. */
async function gradeWith(ctx: CommandContext, config: TrentConfig): Promise<GradeSnapshot> {
  const manager = ctx.config();
  const report = await auditProfileSecurity({
    profile: manager.getProfile(),
    profileDir: manager.getProfileDir(),
    configPath: manager.getConfigPath(),
    secretsPath: manager.getSecretsPath(),
    config,
    cwd: process.cwd(),
    home: manager.getBaseDir(),
  });
  const { grade, score } = gradeSecurity(report);
  return { grade, score };
}

function show(value: unknown): string {
  if (Array.isArray(value)) return value.length === 0 ? "[]" : `[${value.join(", ")}]`;
  return value === undefined ? "(unset)" : String(value);
}

function changeLines(ctx: CommandContext, changes: readonly SecurityPresetChange[]): string[] {
  return changes.map(
    (c) => `    ${ctx.theme.meta(c.key.padEnd(24, " "))} ${ctx.theme.body(show(c.from))} ${ctx.theme.meta("→")} ${ctx.theme.value(show(c.to))}`,
  );
}

function unavailableLines(ctx: CommandContext, unavailable: readonly SecurityPresetUnavailable[]): string[] {
  const lines = ["", `  ${ctx.theme.emphasis("NOT SET BY ANY PRESET")} ${ctx.theme.meta("(no config key exists)")}`];
  for (const u of unavailable) lines.push(`    ${ctx.theme.meta(u.knob.padEnd(24, " "))} ${ctx.theme.body(u.reason)}`);
  return lines;
}

export const presetSubSpec: CommandSpec = {
  name: "preset [name]",
  description: "Apply the paranoid or standard security preset and show the diff and grade; no name shows the active preset",
  async run(ctx, _opts, args) {
    const manager = ctx.config();
    const current = manager.loadConfig();
    const requested = args[0];

    if (requested === undefined || requested === "") {
      const data: ShowData = {
        kind: "show",
        command: "security preset",
        active: matchSecurityPreset(current),
        presets: SECURITY_PRESET_NAMES.map((name) => ({
          name,
          description: SECURITY_PRESET_DESCRIPTIONS[name],
          changes: applySecurityPreset(current, name).changes,
        })),
        unavailable: SECURITY_PRESET_UNAVAILABLE,
      };
      return { data: { ...data } };
    }

    if (!isSecurityPresetName(requested)) {
      throw new TrentError({
        code: EXIT.USAGE,
        operation: "security.preset",
        message: `no preset named "${requested}"; the presets are ${SECURITY_PRESET_NAMES.join(" and ")}`,
        target: requested,
      });
    }

    const { config: next, changes } = applySecurityPreset(current, requested);
    const before = await gradeWith(ctx, current);
    const after = changes.length === 0 ? before : await gradeWith(ctx, next);
    const written = !ctx.dryRun && changes.length > 0;
    if (written) manager.saveConfig(next);

    const data: ApplyData = {
      kind: "apply",
      command: "security preset",
      preset: requested,
      dryRun: ctx.dryRun,
      written,
      activeBefore: matchSecurityPreset(current),
      activeAfter: matchSecurityPreset(next),
      changes,
      grade: { before, after },
      unavailable: SECURITY_PRESET_UNAVAILABLE,
    };
    return { data: { ...data } };
  },
  render(data, ctx) {
    const d = data as unknown as ApplyData | ShowData;
    if (d.kind === "show") {
      const lines = [ctx.theme.emphasis("SECURITY PRESET"), `  ${ctx.theme.meta("active")} ${ctx.theme.value(d.active)}`];
      for (const p of d.presets) {
        lines.push("", `  ${ctx.theme.emphasis(p.name)} ${ctx.theme.meta(p.description)}`);
        lines.push(...(p.changes.length === 0 ? [`    ${ctx.theme.success("already in effect")}`] : changeLines(ctx, p.changes)));
      }
      lines.push("", `  ${ctx.theme.meta("apply one with")} ${ctx.theme.value("trent security preset <paranoid|standard>")}`);
      return [...lines, ...unavailableLines(ctx, d.unavailable)];
    }
    const head = `SECURITY PRESET ${d.preset}${d.dryRun ? " (dry run, nothing written)" : ""}`;
    const lines = [
      ctx.theme.emphasis(head),
      `  ${ctx.theme.meta("active")} ${ctx.theme.value(`${d.activeBefore} → ${d.activeAfter}`)}`,
      `  ${ctx.theme.meta("grade")}  ${ctx.theme.value(`${d.grade.before.grade} → ${d.grade.after.grade}`)} ${ctx.theme.meta(
        `score ${d.grade.before.score} → ${d.grade.after.score}`,
      )}`,
      "",
    ];
    if (d.changes.length === 0) lines.push(`  ${ctx.theme.success(`no change; ${d.preset} is already in effect`)}`);
    else {
      lines.push(`  ${ctx.theme.emphasis(d.written ? "CHANGED" : "WOULD CHANGE")}`);
      lines.push(...changeLines(ctx, d.changes));
    }
    return [...lines, ...unavailableLines(ctx, d.unavailable)];
  },
};
