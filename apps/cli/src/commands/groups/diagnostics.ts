/**
 * `doctor` and `setup`.
 *
 * The doctor is the command that has to be right. Hermes's exits 0 even when checks fail and has no
 * `--json`, so it can gate nothing: not CI, not an installer. Ours returns the report as data, sets
 * exit code 3 whenever a check failed, and renders the human view through `../../ui/`.
 */

import {
  DEFAULT_CHECKS,
  DoctorRunner,
  FixRunner,
  doctorExitCode,
  type DoctorReport,
  type CheckResult,
  type DoctorRunnerOptions,
  type DoctorMode,
} from "@trent/core/doctor/index.js";
import { InquirerPrompts, SetupWizard, type SetupMode } from "@trent/core/setup/index.js";
import { EXIT, TrentError } from "@trent/core/errors/index.js";
import { refuseUnderLiveWriters } from "@trent/core/profile/locks.js";
import type { CommandContext, SetupSummary } from "../context.js";
import type { CommandSpec, JsonData } from "../registry.js";
import { GLYPHS, type AgentState } from "../../ui/index.js";

const STATE_FOR_STATUS: Record<string, AgentState> = {
  ok: "done",
  warn: "needsApproval",
  fail: "failed",
  error: "failed",
  skip: "idle",
};

function runnerOptions(ctx: CommandContext, opts: Record<string, unknown>): DoctorRunnerOptions {
  const options: DoctorRunnerOptions = {};
  if (ctx.overrides.doctorChecks) options.checks = ctx.overrides.doctorChecks;
  if (typeof opts.mode === "string") options.mode = opts.mode as DoctorMode;
  if (typeof opts.healthUrl === "string") options.healthUrl = opts.healthUrl;
  if (typeof opts.timeout === "string" && opts.timeout !== "") {
    const ms = Number(opts.timeout);
    if (!Number.isFinite(ms) || ms <= 0) {
      throw new TrentError({
        code: EXIT.USAGE,
        operation: "doctor.options",
        message: "--timeout must be a positive number of milliseconds",
        target: String(opts.timeout),
      });
    }
    options.probeTimeoutMs = ms;
  }
  return options;
}

function renderReport(report: DoctorReport, ctx: CommandContext): string[] {
  const t = ctx.theme;
  const lines: string[] = [t.emphasis("TRENT DOCTOR"), ""];

  for (const result of report.results) {
    const state = STATE_FOR_STATUS[result.status] ?? "idle";
    const glyph = t.paint(
      state === "done" ? "pulse" : state === "failed" ? "danger" : state === "needsApproval" ? "ember" : "haze",
      GLYPHS[state],
    );
    lines.push(
      `  ${glyph} ${t.value(result.name.padEnd(26, " "))} ${t.body(result.message)}`,
    );
    if (result.status !== "ok" && result.fixHint !== undefined) {
      lines.push(`      ${t.meta(`fix: ${result.fixHint}`)}`);
    }
  }

  lines.push("");
  lines.push(
    `  ${t.meta("total")} ${report.total}  ${t.meta("passed")} ${report.passed}  ` +
      `${t.meta("warnings")} ${report.warnings}  ${t.meta("failed")} ${report.errors}  ` +
      `${t.meta("skipped")} ${report.skipped}  ${t.meta("in")} ${report.durationMs}ms`,
  );
  lines.push(
    report.errors > 0
      ? t.error(`  ${report.errors} check(s) failed — exit ${EXIT.CONFIG}`)
      : t.success("  all checks passed — exit 0"),
  );
  return lines;
}

export const doctorSpec: CommandSpec = {
  name: "doctor",
  description: "Run health diagnostics across config, credentials, agents and systems",
  options: [
    { flags: "--fix", description: "Automatically remediate safe issues" },
    { flags: "--mode <mode>", description: "standalone or connected" },
    { flags: "--health-url <url>", description: "Connected mode health endpoint" },
    { flags: "--timeout <ms>", description: "Per-probe deadline in milliseconds" },
    { flags: "--force", description: "With --fix: remediate even while a REPL, gateway, cron runner or run is writing this profile" },
  ],
  async run(ctx, opts) {
    if (ctx.dryRun) {
      const checks = ctx.overrides.doctorChecks ?? DEFAULT_CHECKS;
      return {
        data: {
          dryRun: true,
          command: "doctor",
          wouldRun: checks.map((c) => ({ id: c.id, name: c.name, category: c.category })),
          fix: opts.fix === true,
        },
      };
    }

    const options = runnerOptions(ctx, opts);

    if (opts.fix === true) {
      // Remediation writes the profile (modes, directories, config); the read-only doctor never
      // refuses, --fix does while another process writes it (`@trent/core/profile/locks`).
      refuseUnderLiveWriters({ profileDirs: [ctx.config().getProfileDir()], operation: "doctor.fix", force: opts.force === true, warn: (line) => ctx.err(line) });
      const fixer = new FixRunner(ctx.config(), options);
      const { actions, newReport } = await fixer.runFixes();
      return {
        data: { ...newReport, actions, exitCode: doctorExitCode(newReport) } as unknown as JsonData,
        exitCode: doctorExitCode(newReport),
      };
    }

    const report = ctx.overrides.doctorRunAll
      ? await ctx.overrides.doctorRunAll()
      : await new DoctorRunner(ctx.config(), options).runAll();

    return {
      data: { ...report, exitCode: doctorExitCode(report) } as unknown as JsonData,
      exitCode: doctorExitCode(report),
    };
  },
  render(data, ctx) {
    const report = data as unknown as DoctorReport & { actions?: { message: string }[] };
    if ((report as { dryRun?: boolean }).dryRun === true) {
      const planned = (data as { wouldRun: { name: string }[] }).wouldRun;
      return [
        ctx.theme.emphasis("TRENT DOCTOR (dry run)"),
        ...planned.map((c) => `  ${ctx.theme.meta("would run")} ${ctx.theme.value(c.name)}`),
      ];
    }
    const lines: string[] = [];
    if (report.actions) {
      lines.push(ctx.theme.emphasis("REMEDIATION"));
      for (const a of report.actions) lines.push(`  ${ctx.theme.body(a.message)}`);
      lines.push("");
    }
    return [...lines, ...renderReport(report, ctx)];
  },
};

export const setupSpec: CommandSpec = {
  name: "setup",
  description: "Run the Trent setup wizard (quick, full or blank-slate)",
  options: [
    { flags: "--mode <mode>", description: "quick, full or blank-slate", defaultValue: "quick" },
    { flags: "--portal", description: "Quick cloud login setup" },
    { flags: "--provider <provider>", description: "Default model provider" },
    { flags: "--model <model>", description: "Default model" },
  ],
  async run(ctx, opts) {
    const mode = (opts.portal === true ? "quick" : String(opts.mode ?? "quick")) as SetupMode;
    if (!["quick", "full", "blank-slate"].includes(mode)) {
      throw new TrentError({
        code: EXIT.USAGE,
        operation: "setup.options",
        message: "--mode must be quick, full or blank-slate",
        target: mode,
      });
    }

    if (ctx.dryRun) {
      return {
        data: {
          dryRun: true,
          command: "setup",
          mode,
          profile: ctx.profile,
          wouldWrite: [ctx.config().getConfigPath(), ctx.config().getSecretsPath()],
        },
      };
    }

    const summary = await runSetup(ctx, mode, opts);
    // A setup that did not complete is a configuration failure a script must see: exit 3.
    return { data: { ...summary }, ...(summary.success ? {} : { exitCode: EXIT.CONFIG }) };
  },
  render(data, ctx) {
    if ((data as { dryRun?: boolean }).dryRun === true) {
      const d = data as { mode: string; wouldWrite: string[] };
      return [
        ctx.theme.emphasis(`TRENT SETUP (dry run, ${d.mode})`),
        ...d.wouldWrite.map((p) => `  ${ctx.theme.meta("would write")} ${ctx.theme.value(p)}`),
      ];
    }
    const d = data as unknown as SetupSummary;
    return [
      ...(d.success
        ? [ctx.theme.success("Setup complete"), `  ${ctx.theme.body(d.message)}`]
        : [ctx.theme.error(`Setup did not complete: ${d.message}`)]),
      d.secretsConfigured.length > 0
        ? `  ${ctx.theme.meta("secrets configured")} ${ctx.theme.value(d.secretsConfigured.join(", "))}`
        : `  ${ctx.theme.meta("no secrets written")}`,
    ];
  },
};

/**
 * Shared by `trent setup` and the first-run path in `../index.ts`.
 *
 * The wizard speaks through the command context, not straight to `process.stdout`: under `--json`
 * its lines and its prompts go to stderr, so stdout carries exactly one JSON document.
 */
export async function runSetup(
  ctx: CommandContext,
  mode: SetupMode,
  opts: Record<string, unknown>,
): Promise<SetupSummary> {
  if (ctx.overrides.runSetup) return await ctx.overrides.runSetup(mode, opts);

  const wizard = new SetupWizard({
    configManager: ctx.config(),
    output: { write: (line) => (ctx.json ? ctx.err(line) : ctx.out(line)) },
    prompts: new InquirerPrompts(ctx.json ? { output: process.stderr } : {}),
  });
  const setupOptions: Parameters<SetupWizard["run"]>[0] = { mode };
  if (typeof opts.provider === "string") {
    setupOptions.provider = opts.provider as NonNullable<typeof setupOptions.provider>;
  }
  if (typeof opts.model === "string") setupOptions.model = opts.model;

  const result = await wizard.run(setupOptions);
  return {
    mode: result.mode,
    success: result.success,
    message: result.message,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
    // Names only. A value never leaves the secrets file.
    secretsConfigured: result.secretsConfigured,
  };
}

export function summariseChecks(results: readonly CheckResult[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
  return counts;
}
