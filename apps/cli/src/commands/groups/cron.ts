/**
 * The `cron` group: `trent cron list|add|pause|resume|remove|run <id>` over the same
 * `<profile>/cron/jobs.json` the `cronjob_manage` tool writes.
 *
 * Every read and write goes through the toolset's own helpers (`readCronJobs`, `writeCronJobs`,
 * `newCronJob`), so the file format has one owner. `add` runs the same cron validation and
 * injection scan as the tool; a finding names its category, never the matched text, because the
 * prompt may carry a credential. `run` is honest: no runner exists in this release, so it is a
 * `TrentError` rather than a summary that looks like execution.
 */
import { EXIT, TrentError } from "@trent/core/errors/index.js";
import {
  newCronJob,
  readCronJobs,
  scanPromptForInjection,
  validateCronExpression,
  writeCronJobs,
  type CronJob,
} from "@trent/core/tools/cron/index.js";
import type { CommandSpec } from "../registry.js";
import type { CommandContext } from "../context.js";

export const CRON_RUNNER_MISSING = "cron runner not started; run `trent cron start`";

function fail(operation: string, message: string, target?: string): never {
  throw new TrentError({ code: EXIT.CONFIG, operation, message, ...(target === undefined ? {} : { target }) });
}

function profileDir(ctx: CommandContext): string {
  return ctx.config().getProfileDir();
}

function optionalString(opts: Record<string, unknown>, key: string): string | undefined {
  const value = typeof opts[key] === "string" ? opts[key].trim() : "";
  return value.length > 0 ? value : undefined;
}

/** The validated fields of `add`; throws the same refusals the tool reports, as config errors. */
function validateAdd(opts: Record<string, unknown>): { name: string | undefined; schedule: string; prompt: string; deliver: string | undefined } {
  const prompt = optionalString(opts, "prompt");
  if (prompt === undefined) fail("cron.add", "add requires --prompt <text>");
  const schedule = validateCronExpression(opts.schedule);
  if (!schedule.ok) fail("cron.add", `invalid schedule: ${schedule.reason}`, String(opts.schedule ?? ""));
  const findings = scanPromptForInjection(prompt);
  if (findings.length > 0) {
    const reasons = [...new Set(findings.map((f) => `${f.category}: ${f.reason}`))];
    fail("cron.add", `prompt refused (prompt injection / credential scan): ${reasons.join("; ")}. Scheduled prompts run unattended; rewrite the prompt without it`);
  }
  return { name: optionalString(opts, "name"), schedule: schedule.normalized, prompt, deliver: optionalString(opts, "deliver") };
}

function findJob(ctx: CommandContext, operation: string, id: string): { jobs: CronJob[]; job: CronJob } {
  const jobs = readCronJobs(profileDir(ctx));
  const job = jobs.find((j) => j.id === id);
  if (!job) fail(operation, "no scheduled job with that id; run `trent cron list`", id);
  return { jobs, job };
}

function setEnabled(ctx: CommandContext, id: string, enabled: boolean) {
  const operation = enabled ? "cron.resume" : "cron.pause";
  if (ctx.dryRun) return { data: { dryRun: true, command: enabled ? "cron resume" : "cron pause", id } };
  const { jobs, job } = findJob(ctx, operation, id);
  const stamp = (ctx.overrides.now ?? (() => new Date()))().toISOString();
  const next: CronJob = { ...job, enabled, updated_at: stamp };
  writeCronJobs(profileDir(ctx), jobs.map((j) => (j.id === id ? next : j)));
  return { data: { id, name: next.name, enabled: next.enabled, updated_at: next.updated_at } };
}

function renderFlip(data: unknown, ctx: CommandContext): string[] {
  const d = data as { id: string; enabled: boolean; dryRun?: boolean; command?: string };
  if (d.dryRun === true) return [`  ${ctx.theme.meta(`would ${String(d.command).replace("cron ", "")}`)} ${ctx.theme.value(d.id)}`];
  return [`  ${ctx.theme.success(d.enabled ? "enabled" : "paused")} ${ctx.theme.value(d.id)}`];
}

function jobLine(job: CronJob, ctx: CommandContext): string {
  const state = job.enabled ? ctx.theme.success("on ") : ctx.theme.meta("off");
  const deliver = job.deliver ? ` ${ctx.theme.meta(`-> ${job.deliver}`)}` : "";
  return `  ${state} ${ctx.theme.value(job.id)} ${ctx.theme.meta(job.schedule.padEnd(12, " "))} ${ctx.theme.body(job.name)}${deliver}`;
}

export const cronSpec: CommandSpec = {
  name: "cron",
  description: "Manage scheduled jobs in <profile>/cron/jobs.json (the schedule the cron toolset writes)",
  subcommands: [
    {
      name: "list",
      description: "List scheduled jobs",
      run(ctx) {
        return { data: { jobs: readCronJobs(profileDir(ctx)) } };
      },
      render(data, ctx) {
        const d = data as { jobs: CronJob[] };
        const lines = [ctx.theme.emphasis(`SCHEDULED JOBS (${d.jobs.length})`)];
        for (const job of d.jobs) lines.push(jobLine(job, ctx));
        if (d.jobs.length === 0) lines.push(ctx.theme.meta("  none; trent cron add --schedule <cron> --prompt <text> [--deliver <target>] [--name <name>]"));
        lines.push(ctx.theme.meta("  the schedule is written only; no runner executes it in this release"));
        return lines;
      },
    },
    {
      name: "add",
      description: "Schedule a job: --schedule (five-field cron or @hourly/@daily/@weekly/@monthly) and --prompt",
      options: [
        { flags: "--schedule <cron>", description: "Five-field cron expression or an @alias" },
        { flags: "--prompt <text>", description: "What the job should do when it runs; scanned for injection" },
        { flags: "--deliver <target>", description: "Where the result goes, e.g. slack:#channel" },
        { flags: "--name <name>", description: "Display name; defaults to the start of the prompt" },
      ],
      run(ctx, opts) {
        if (ctx.dryRun) {
          // Reports instead of throwing: `--dry-run` must always answer with JSON and exit 0.
          try {
            const input = validateAdd(opts);
            return { data: { dryRun: true, command: "cron add", schedule: input.schedule, name: input.name ?? null, problems: [] } };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { data: { dryRun: true, command: "cron add", schedule: null, name: null, problems: [message] } };
          }
        }
        const input = validateAdd(opts);
        const dir = profileDir(ctx);
        const stamp = (ctx.overrides.now ?? (() => new Date()))().toISOString();
        const job = newCronJob(input, stamp);
        const jobs = [...readCronJobs(dir), job];
        writeCronJobs(dir, jobs);
        return { data: { added: job, count: jobs.length } };
      },
      render(data, ctx) {
        const d = data as { added?: CronJob; dryRun?: boolean; schedule?: string | null; problems?: string[] };
        if (d.dryRun === true) {
          return d.problems?.length ? d.problems.map((p) => `  ${ctx.theme.meta("would refuse")}: ${p}`) : [`  ${ctx.theme.meta("would add")} ${String(d.schedule)}`];
        }
        if (!d.added) return [];
        return [jobLine(d.added, ctx), ctx.theme.meta("  scheduled; nothing runs until a cron runner is started")];
      },
    },
    {
      name: "pause <id>",
      description: "Disable a scheduled job without deleting it",
      run: (ctx, _opts, args) => setEnabled(ctx, String(args[0]), false),
      render: renderFlip,
    },
    {
      name: "resume <id>",
      description: "Re-enable a paused job",
      run: (ctx, _opts, args) => setEnabled(ctx, String(args[0]), true),
      render: renderFlip,
    },
    {
      name: "remove <id>",
      description: "Delete a scheduled job",
      run(ctx, _opts, args) {
        const id = String(args[0]);
        if (ctx.dryRun) return { data: { dryRun: true, command: "cron remove", id } };
        const { jobs } = findJob(ctx, "cron.remove", id);
        const remaining = jobs.filter((j) => j.id !== id);
        writeCronJobs(profileDir(ctx), remaining);
        return { data: { removed: id, count: remaining.length } };
      },
      render(data, ctx) {
        const d = data as { removed?: string; id?: string; dryRun?: boolean };
        if (d.dryRun === true) return [`  ${ctx.theme.meta("would remove")} ${ctx.theme.value(String(d.id))}`];
        return [`  ${ctx.theme.success("removed")} ${ctx.theme.value(String(d.removed))}`];
      },
    },
    {
      name: "run <id>",
      description: "Run a scheduled job now (requires the cron runner)",
      run(ctx, _opts, args) {
        const id = String(args[0]);
        // `--dry-run` reports instead of throwing, and the honest report is that the run would be refused.
        if (ctx.dryRun) return { data: { dryRun: true, command: "cron run", id, wouldRefuse: CRON_RUNNER_MISSING } };
        findJob(ctx, "cron.run", id);
        throw new TrentError({ code: EXIT.CONFIG, operation: "cron.run", message: CRON_RUNNER_MISSING, target: id });
      },
      render(data, ctx) {
        const d = data as { id: string; wouldRefuse: string };
        return [`  ${ctx.theme.meta("would refuse")} ${ctx.theme.value(d.id)}: ${d.wouldRefuse}`];
      },
    },
  ],
};
