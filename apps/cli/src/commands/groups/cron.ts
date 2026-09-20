/**
 * The `cron` group: `trent cron list|add|pause|resume|remove|run|runs|start` over the same
 * `<profile>/cron/jobs.json` the `cronjob_manage` tool writes, plus `incidents` and `queue`
 * (`./cron-queue.ts`).
 *
 * Every read and write goes through the toolset's own helpers (`readCronJobs`, `writeCronJobs`,
 * `newCronJob`), so the file format has one owner. `add` runs the same cron validation and
 * injection scan as the tool; a finding names its category, never the matched text, because the
 * prompt may carry a credential. `run` and `start` execute through the headless runtime — the
 * same object graph the REPL and the gateway run on — via `CronRunner`, and a job's `deliver`
 * target (`slack:#channel`, `telegram:<chatId>`) goes through the gateway manager's `send`.
 * [X4] So does the one `[CRON_FAILURE]` alert an incident sends, to `gateway.owner`, the path
 * the heartbeat's replies take; `cron.failure_alert_after` and `cron.quota_hold_minutes` come
 * from config.
 */
import process from "node:process";
import { CronRunner, DEFAULT_TICK_MS, readCronRuns, type CronRunRow } from "@trent/core/cron/index.js";
import { SOCIAL_PUBLISH_HANDLER, createSocialPublishHandler } from "@trent/core/tools/social/index.js";
import { EXIT, TrentError } from "@trent/core/errors/index.js";
import { GatewayManager } from "@trent/core/gateway/index.js";
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
import { cronIncidentsSpec, cronQueueSpec } from "./cron-queue.js";
import type { ReplConfig } from "../../repl/types.js";
import { createHeadlessRuntime, type HeadlessRuntime } from "../../runtime/headless.js";
import { releaseOnSignal, type SignalTarget } from "../../signals.js";

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

/** `platform:channel` — the first colon splits, so a Slack channel or an email address keeps its own colons. */
function parseDeliverTarget(target: string): { platform: string; channelId: string } {
  const colon = target.indexOf(":");
  const platform = colon > 0 ? target.slice(0, colon).trim().toLowerCase() : "";
  const channelId = colon > 0 ? target.slice(colon + 1).trim() : "";
  if (platform === "" || channelId === "") {
    throw new TrentError({ code: EXIT.CONFIG, operation: "cron.deliver", message: "deliver target must be <platform>:<channel>, e.g. slack:#sales or telegram:123456", target });
  }
  return { platform, channelId };
}

/**
 * The runner over this profile's schedule, on the headless runtime. The gateway manager is built
 * on first delivery only, so a job with no `deliver` target never touches the gateway config.
 */
async function openRunner(ctx: CommandContext): Promise<{ runner: CronRunner; runtime: HeadlessRuntime; close: () => Promise<void> }> {
  const configManager = ctx.config();
  const config = configManager.loadConfig();
  const runtime = await (ctx.overrides.gatewayRuntime ?? createHeadlessRuntime)({ configManager, config: config as unknown as ReplConfig });
  const buildManager = ctx.overrides.gatewayManager ?? ((cm, options) => new GatewayManager(cm, options));
  let manager: GatewayManager | undefined;
  const owner = config.gateway.owner;
  const send = async (platform: string, channelId: string, text: string, subject: string, operation: string): Promise<void> => {
    manager ??= buildManager(configManager, {});
    const receipt = await manager.send(platform, { channelId, text, metadata: { subject } });
    if (!receipt.sent) {
      throw new TrentError({ code: EXIT.PROVIDER, operation, message: `queued as ${receipt.queued} but not sent; the gateway will retry when ${platform} is reachable`, target: `${platform}:${channelId}` });
    }
  };
  const runner = new CronRunner({
    profileDir: configManager.getProfileDir(),
    // [G3.1] A scheduled job's cost is cron's, even when it rides the gateway's runtime.
    run: (prompt, options) => runtime.run(prompt, { ...options, surface: "cron" }),
    // [B1] A queued social post is a handled job: the approval bound at queue time is re-read
    // from this profile's rows and the post leaves once through the idempotent path; no prompt.
    handlers: { [SOCIAL_PUBLISH_HANDLER]: createSocialPublishHandler({ profileDir: configManager.getProfileDir(), social: { manager: configManager } }) },
    now: ctx.overrides.now,
    log: (line) => ctx.err(line),
    failureAlertAfter: config.cron.failure_alert_after,
    quotaHoldMinutes: config.cron.quota_hold_minutes,
    deliver: async (target, text, job) => {
      const { platform, channelId } = parseDeliverTarget(target);
      await send(platform, channelId, text, `Trent cron: ${job.name}`, "cron.deliver");
    },
    // [X4] The incident alert goes to the owner, as a heartbeat reply does; without one there is no path.
    alert: async (text) => {
      if (owner === undefined) throw new TrentError({ code: EXIT.CONFIG, operation: "cron.alert", message: "gateway.owner is not configured; set gateway.owner { platform, channelId } in config.yaml" });
      await send(owner.platform, owner.channelId, text, "Trent cron: failure incident", "cron.alert");
    },
  });
  return {
    runner,
    runtime,
    close: async () => {
      runner.stop();
      await manager?.stopAll();
      await runtime.cleanup();
    },
  };
}

/**
 * A keep-alive runner releases the lock, the manager and the runtime on Ctrl+C as well as on
 * SIGTERM/SIGHUP. The claim is what makes the difference: the binary's global SIGINT handler
 * exits the moment the signal lands, which pre-empts the release that the other two signals get,
 * so `cron start` takes the interrupt for itself exactly as `gateway start` does
 * (`../../signals.ts`). The `exit` hook stays as the last resort that still drops the pid lock.
 */
function releaseOnExit(close: () => Promise<void>, stopSync: () => void, signals?: SignalTarget): void {
  releaseOnSignal(close, signals);
  (signals ?? process).once("exit", stopSync);
}

function runLine(row: CronRunRow, ctx: CommandContext): string {
  const status = row.status === "completed" ? ctx.theme.success("completed") : ctx.theme.meta("failed   ");
  const cost = row.costCents !== undefined ? ` ${ctx.theme.meta(`${row.costCents}c`)}` : "";
  const delivery = row.deliveryError !== undefined ? ` ${ctx.theme.meta(`delivery failed: ${row.deliveryError}`)}` : "";
  return `  ${status} ${ctx.theme.value(row.startedAt)} ${ctx.theme.meta(row.trigger.padEnd(9, " "))}${cost} ${ctx.theme.body(row.summary)}${delivery}`;
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
        lines.push(ctx.theme.meta("  a runner executes this schedule while `trent cron start` is running"));
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
        return [jobLine(d.added, ctx), ctx.theme.meta("  scheduled; it runs while `trent cron start` is up, or now with `trent cron run <id>`")];
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
      description: "Run a scheduled job now on the headless runtime; the summary is recorded and delivered",
      async run(ctx, _opts, args) {
        const id = String(args[0]);
        if (ctx.dryRun) return { data: { dryRun: true, command: "cron run", id } };
        findJob(ctx, "cron.run", id);
        const { runner, close } = await openRunner(ctx);
        try {
          const row = await runner.runNow(id);
          if (row.status === "failed") {
            throw new TrentError({ code: EXIT.PROVIDER, operation: "cron.run", message: row.summary, target: id });
          }
          return { data: { id, run: row } };
        } finally {
          await close();
        }
      },
      render(data, ctx) {
        const d = data as { id: string; run?: CronRunRow; dryRun?: boolean };
        if (d.dryRun === true) return [`  ${ctx.theme.meta("would run")} ${ctx.theme.value(d.id)}`];
        return d.run ? [runLine(d.run, ctx)] : [];
      },
    },
    {
      name: "runs <id>",
      description: "Show a job's run history from <profile>/cron/runs/<id>.jsonl",
      options: [{ flags: "--last <n>", description: "Only the newest N rows", defaultValue: "50" }],
      run(ctx, opts, args) {
        const id = String(args[0]);
        const last = Number.parseInt(String(opts.last ?? "50"), 10);
        if (!Number.isInteger(last) || last < 1) fail("cron.runs", "--last must be a positive integer", String(opts.last));
        if (ctx.dryRun) return { data: { dryRun: true, command: "cron runs", id, last } };
        findJob(ctx, "cron.runs", id);
        const rows = readCronRuns(profileDir(ctx), id);
        return { data: { id, runs: rows.slice(Math.max(0, rows.length - last)) } };
      },
      render(data, ctx) {
        const d = data as { id: string; runs?: CronRunRow[]; dryRun?: boolean };
        if (d.dryRun === true) return [`  ${ctx.theme.meta("would list runs of")} ${ctx.theme.value(d.id)}`];
        const rows = d.runs ?? [];
        const lines = [ctx.theme.emphasis(`RUNS OF ${d.id} (${rows.length})`)];
        for (const row of rows) lines.push(runLine(row, ctx));
        if (rows.length === 0) lines.push(ctx.theme.meta("  none yet; trent cron run <id> runs it now"));
        return lines;
      },
    },
    {
      name: "start",
      description: "Run the scheduler: tick <profile>/cron/jobs.json every 30s and launch due jobs",
      options: [{ flags: "--once", description: "Tick once and exit (for an external scheduler such as launchd or system cron)" }],
      async run(ctx, opts) {
        const jobs = readCronJobs(profileDir(ctx)).filter((j) => j.enabled).length;
        if (ctx.dryRun) return { data: { dryRun: true, command: "cron start", jobs, intervalMs: DEFAULT_TICK_MS } };
        const { runner, close } = await openRunner(ctx);
        if (opts.once === true) {
          try {
            const { launched, held } = await runner.tick();
            return { data: { once: true, launched, jobs, ...(held === undefined ? {} : { held }) } };
          } finally {
            await close();
          }
        }
        try {
          runner.start();
        } catch (error) {
          await close();
          throw error;
        }
        releaseOnExit(close, () => runner.stop(), ctx.overrides.signals);
        return { data: { started: true, pid: process.pid, intervalMs: DEFAULT_TICK_MS, jobs }, keepAlive: true };
      },
      render(data, ctx) {
        const d = data as { dryRun?: boolean; once?: boolean; launched?: string[]; held?: string[]; started?: boolean; jobs: number; intervalMs?: number };
        if (d.dryRun === true) return [`  ${ctx.theme.meta("would start the runner over")} ${ctx.theme.value(`${d.jobs} enabled job(s)`)}`];
        if (d.once === true) {
          const launched = d.launched ?? [];
          const held = d.held ?? [];
          return [
            `  ${ctx.theme.success("ticked")} ${ctx.theme.value(launched.length > 0 ? launched.join(", ") : "nothing due")}`,
            ...(held.length > 0 ? [`  ${ctx.theme.meta("held by the quota hold:")} ${ctx.theme.value(held.join(", "))}`] : []),
          ];
        }
        return [
          `  ${ctx.theme.success("runner started")} ${ctx.theme.meta(`pid ${process.pid}, every ${Math.round((d.intervalMs ?? DEFAULT_TICK_MS) / 1000)}s over ${d.jobs} enabled job(s)`)}`,
          ctx.theme.meta("  Ctrl+C stops it; run history is under <profile>/cron/runs/"),
        ];
      },
    },
    cronIncidentsSpec,
    cronQueueSpec,
  ],
};
