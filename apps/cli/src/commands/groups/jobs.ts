/**
 * The `jobs` group: `trent jobs failed [--last N]` lists the failed JobRun rows of this profile's
 * store, newest first; `trent jobs retry <id> [--objective <text>]` launches the failed job's run
 * objective again through the headless runtime as a new manual run.
 *
 * Both open the same headless runtime the REPL, the gateway, the cron runner and the heartbeat run
 * on (`ctx.overrides.gatewayRuntime` is the test seam), because the profile's company id is only
 * known to that graph: the store lists job rows per company, and there is no company listing on the
 * REPL store slice. The runtime is released on every exit path.
 *
 * The retry link. The row's `metadata` payload names the run behind a failed job (`runId`, as the
 * wrapped application's drain loop writes it) or the objective itself (`objective`); with neither,
 * the caller passes `--objective`. The new run is linked to the old job by a row of type
 * `orchestration_retry` whose payload holds `{ retryOf, runId }` and whose summary names both, so
 * a store that drops the payload still keeps the link in text.
 */
import { EXIT, TrentError, type ExitCode } from "@trent/core/errors/index.js";
import type { OrcEvent } from "@trent/core/orchestrator/index.js";
import type { CommandSpec } from "../registry.js";
import type { CommandContext } from "../context.js";
import type { JobRunRow, ReplConfig, ReplStore } from "../../repl/types.js";
import { createHeadlessRuntime, type HeadlessRuntime } from "../../runtime/headless.js";

/** How many rows are read from the store before the failed ones are picked out. */
const SCAN_LIMIT = 500;
const DEFAULT_LAST = 20;
const RETRY_ROW_TYPE = "orchestration_retry";

/** The store row as the durable store returns it; `completedAt` and `error` are read structurally. */
interface JobRow extends JobRunRow {
  trigger: string;
  completedAt?: Date | null;
  error?: string | null;
}

export interface FailedJob {
  id: string;
  type: string;
  trigger: string;
  finishedAt: string | null;
  error: string | null;
  summary: string;
}

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function finishedAt(row: JobRow): string | null {
  return iso(row.completedAt ?? row.startedAt);
}

function toFailedJob(row: JobRow): FailedJob {
  return { id: row.id, type: row.type, trigger: row.trigger, finishedAt: finishedAt(row), error: row.error ?? null, summary: row.summary };
}

/** The failed rows of this company, newest first. */
async function listFailed(store: ReplStore, companyId: string): Promise<JobRow[]> {
  const rows = (await store.listJobRuns(companyId, SCAN_LIMIT)) as unknown as JobRow[];
  return rows
    .filter((row) => row.status === "failed")
    .sort((a, b) => (finishedAt(b) ?? "").localeCompare(finishedAt(a) ?? ""));
}

function parseLast(raw: unknown, operation: string): number {
  const last = Number.parseInt(String(raw ?? DEFAULT_LAST), 10);
  if (!Number.isInteger(last) || last < 1) {
    throw new TrentError({ code: EXIT.CONFIG, operation, message: "--last must be a positive integer", target: String(raw) });
  }
  return last;
}

async function withRuntime<T>(ctx: CommandContext, work: (runtime: HeadlessRuntime) => Promise<T>): Promise<T> {
  const configManager = ctx.config();
  const config = configManager.loadConfig();
  const runtime = await (ctx.overrides.gatewayRuntime ?? createHeadlessRuntime)({ configManager, config: config as unknown as ReplConfig });
  try {
    return await work(runtime);
  } finally {
    await runtime.cleanup();
  }
}

function metadataString(row: JobRow, key: "runId" | "objective"): string | undefined {
  const value = row.metadata?.[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * The objective to retry, in order: the caller's `--objective`; the linked run's objective when
 * the row's metadata names a run that is in the store; the `objective` the metadata itself carries.
 */
async function objectiveFor(store: ReplStore, row: JobRow, explicit: string | undefined): Promise<string> {
  if (explicit !== undefined && explicit.trim() !== "") return explicit;
  const runId = metadataString(row, "runId");
  const run = runId === undefined ? null : await store.getRun(runId);
  if (run !== null && run.objective.trim() !== "") return run.objective;
  const recorded = metadataString(row, "objective");
  if (recorded !== undefined) return recorded;
  throw new TrentError({
    code: EXIT.CONFIG,
    operation: "jobs.retry",
    message: runId === undefined
      ? "the store keeps no run link or objective on this job row; pass --objective <text> to say what to run again"
      : `run ${runId} behind this job is not in the store; pass --objective <text> to say what to run again`,
    target: row.id,
  });
}

interface RetryOutcome {
  runId: string | null;
  status: string;
  summary: string | null;
}

/** Drives the run to its end and reports how it ended; a stream that closes without a verdict is reported as such. */
async function driveRun(events: AsyncIterable<OrcEvent>): Promise<RetryOutcome> {
  let runId: string | null = null;
  let status = "unfinished";
  let summary: string | null = null;
  for await (const event of events) {
    if (event.kind === "run_start") runId = event.runId;
    if (event.kind === "run_done" || event.kind === "run_failed" || event.kind === "run_cancelled") {
      runId ??= event.runId;
      status = event.run?.status ?? (event.kind === "run_done" ? "completed" : event.kind === "run_failed" ? "failed" : "cancelled");
      summary = event.run?.summary ?? event.detail ?? null;
    }
  }
  return { runId, status, summary };
}

/** Writes the link row: the payload names the failed job and the new run, and so does the summary. */
async function recordLink(store: ReplStore, companyId: string, retryOf: string, runId: string | null): Promise<string> {
  const row = await store.createJobRun({
    type: RETRY_ROW_TYPE,
    trigger: "manual",
    companyId,
    summary: `retry of ${retryOf}${runId === null ? "" : ` as run ${runId}`}`,
    metadata: { retryOf, ...(runId === null ? {} : { runId }) },
  });
  return row.id;
}

function exitFor(status: string): ExitCode {
  return status === "completed" ? EXIT.OK : EXIT.PROVIDER;
}

export const jobsSpec: CommandSpec = {
  name: "jobs",
  description: "Failed job runs of this profile, and retrying one",
  subcommands: [
    {
      name: "failed",
      description: "List the failed job runs recorded in this profile's store, newest first",
      options: [{ flags: "--last <n>", description: "Only the newest N failures", defaultValue: String(DEFAULT_LAST) }],
      async run(ctx, opts) {
        const last = parseLast(opts.last, "jobs.failed");
        if (ctx.dryRun) return { data: { dryRun: true, command: "jobs failed", last } };
        return withRuntime(ctx, async (runtime) => {
          const rows = (await listFailed(runtime.store, runtime.companyId)).slice(0, last);
          return { data: { count: rows.length, durable: runtime.durable, jobs: rows.map(toFailedJob) } };
        });
      },
      render(data, ctx) {
        const d = data as { dryRun?: boolean; last?: number; count?: number; durable?: boolean; jobs?: FailedJob[] };
        if (d.dryRun === true) return [`  ${ctx.theme.meta("would list the newest")} ${ctx.theme.value(String(d.last))} ${ctx.theme.meta("failed job runs")}`];
        const jobs = d.jobs ?? [];
        const lines = [ctx.theme.emphasis(`FAILED JOBS (${jobs.length})`)];
        for (const job of jobs) {
          lines.push(`  ${ctx.theme.error(job.id.padEnd(26, " "))} ${ctx.theme.value(job.finishedAt ?? "")} ${ctx.theme.body(job.type)} ${ctx.theme.meta(job.trigger)}`);
          lines.push(`    ${ctx.theme.meta(job.error ?? job.summary)}`);
        }
        if (jobs.length === 0) {
          lines.push(ctx.theme.meta(d.durable === false ? "  the store is not durable under this runtime, so no job rows are kept" : "  no failed job runs recorded"));
        }
        return lines;
      },
    },
    {
      name: "retry <id>",
      description: "Run a failed job's objective again as a new manual run, linked to the failed job",
      options: [{ flags: "--objective <text>", description: "What to run, when the job row keeps no link to its run" }],
      async run(ctx, opts, args) {
        const jobId = String(args[0]);
        const objective = typeof opts.objective === "string" ? opts.objective : undefined;
        if (ctx.dryRun) return { data: { dryRun: true, command: "jobs retry", jobId, objective: objective ?? null } };
        return withRuntime(ctx, async (runtime) => {
          const row = (await listFailed(runtime.store, runtime.companyId)).find((candidate) => candidate.id === jobId);
          if (row === undefined) {
            throw new TrentError({ code: EXIT.CONFIG, operation: "jobs.retry", message: "no failed job run with that id in this profile; trent jobs failed lists them", target: jobId });
          }
          const resolved = await objectiveFor(runtime.store, row, objective);
          const outcome = await driveRun(runtime.run(resolved, { trigger: "manual" }));
          const link = await recordLink(runtime.store, runtime.companyId, jobId, outcome.runId);
          return { data: { retryOf: jobId, objective: resolved, ...outcome, link }, exitCode: exitFor(outcome.status) };
        });
      },
      render(data, ctx) {
        const d = data as { dryRun?: boolean; jobId?: string; retryOf?: string; runId?: string | null; status?: string; summary?: string | null };
        if (d.dryRun === true) return [`  ${ctx.theme.meta("would retry")} ${ctx.theme.value(String(d.jobId))}`];
        const verdict = d.status === "completed" ? ctx.theme.success("completed") : ctx.theme.error(String(d.status));
        const lines = [`  ${verdict} ${ctx.theme.meta("retry of")} ${ctx.theme.value(String(d.retryOf))} ${ctx.theme.meta("as run")} ${ctx.theme.value(String(d.runId ?? "none"))}`];
        if (d.summary !== null && d.summary !== undefined && d.summary !== "") lines.push(`    ${ctx.theme.body(d.summary)}`);
        return lines;
      },
    },
  ],
};
