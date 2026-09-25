/**
 * The cron runner: ticks `<profile>/cron/jobs.json`, launches every due job once, keeps a run
 * history per job and hands each summary to the injected delivery function.
 *
 * The order inside a tick is the whole design. For every due job the runner FIRST persists
 * `last_run_at` and the next slot (one atomic rewrite of jobs.json), THEN launches the prompt.
 * A process that dies between the two loses that one run and records nothing; it never fires
 * the same slot twice on restart, which is the failure a scheduler must not have.
 *
 * Nothing here composes text. The history row's `summary` is the run's own consolidated brief
 * off the orchestrator's event stream, exactly as the gateway's agent handler reads it, and a
 * failed run records the reason the `run_failed` frame carries. The runner logs job ids,
 * statuses and durations; a prompt body never reaches the log.
 */
import path from "node:path";
import process from "node:process";
import { NODE_IO, atomicWriteFileSync, type ConfigIO } from "../config/atomic-fs.js";
import { EXIT, TrentError } from "../errors/index.js";
import type { OrcEvent, OrchestrationTrigger } from "../orchestrator/types.js";
import { acquireProfileWriter } from "../profile/locks.js";
import { StructuredLogger } from "../telemetry/logger.js";
import {
  cronRunnerActive,
  cronRunnerLockPath,
  readCronJobs,
  readCronRunnerLock,
  writeCronJobs,
  type CronJob,
} from "../tools/cron/index.js";
import {
  DEFAULT_FAILURE_ALERT_AFTER,
  DEFAULT_QUOTA_HOLD_MINUTES,
  failureAlertText,
  markAlerted,
  quotaHoldUntil,
  rateLimitOf,
  readCronIncidents,
  recordFailure,
  recordRateLimit,
  recordSuccess,
  writeCronIncidents,
  type CronIncidentsState,
} from "./incidents.js";
import { nextRun } from "./next-run.js";

export const DEFAULT_TICK_MS = 30_000;
export const DEFAULT_HISTORY_LIMIT = 50;
const RUNS_FILE_MODE = 0o600;

/** One line of `<profile>/cron/runs/<jobId>.jsonl`. */
export interface CronRunRow {
  startedAt: string;
  endedAt: string;
  status: "completed" | "failed";
  /** `scheduled` for a tick, `manual` for `trent cron run`; the orchestrator sees `scheduled` either way. */
  trigger: "scheduled" | "manual";
  summary: string;
  costCents?: number;
  /** Set when the run finished but `deliver` threw; the summary is still on disk here. */
  deliveryError?: string;
}

export interface CronRunOptions {
  readonly trigger: OrchestrationTrigger;
  readonly signal?: AbortSignal;
  /**
   * [P1-D] The job's pinned model (`CronJob.model`). Absent, not undefined, for an unpinned job, so
   * the model is the one configured at fire time. A `run` that cannot honour a pin must refuse it
   * rather than run the job on another model.
   */
  readonly model?: string;
}

/** [B1] What a handler answers for a job that names it; the row records it as a run would be. */
export interface CronHandlerResult {
  readonly summary: string;
  readonly failed?: boolean;
  readonly costCents?: number;
}

export type CronJobHandler = (job: CronJob, options: { readonly now: Date; readonly trigger: CronRunRow["trigger"] }) => Promise<CronHandlerResult>;

export interface CronRunnerDeps {
  readonly profileDir: string;
  /** One orchestrated run in a fresh session; the headless runtime's `run`. */
  readonly run: (prompt: string, options: CronRunOptions) => AsyncIterable<OrcEvent>;
  /**
   * [B1] Handlers for jobs that carry `handler`: the job never runs as a prompt, the handler
   * runs with the job's `payload`. A job naming a handler nobody registered records a failed row.
   */
  readonly handlers?: Readonly<Record<string, CronJobHandler>>;
  /** Sends `text` to a job's `deliver` target (`telegram:<chatId>`, `slack:#channel`); `job` names the sender. */
  readonly deliver?: (target: string, text: string, job: CronJob) => Promise<void>;
  readonly now?: () => Date;
  readonly io?: Partial<ConfigIO>;
  readonly intervalMs?: number;
  readonly historyLimit?: number | undefined;
  /** Where structured log lines go; stderr by default. */
  readonly log?: (line: string) => void;
  /**
   * [X4] Sends an incident alert to the gateway owner (`gateway.owner`), the path the heartbeat's
   * replies take. Called exactly once per incident; a throw is logged and the incident stays open.
   */
  readonly alert?: (text: string) => Promise<void>;
  /** [X4] Consecutive scheduled failures of one job before the one alert; `cron.failure_alert_after`. */
  readonly failureAlertAfter?: number | undefined;
  /** [X4] How long a provider 429 holds every prompt-driven job when it names no `Retry-After`; `cron.quota_hold_minutes`. */
  readonly quotaHoldMinutes?: number | undefined;
}

export interface TickResult {
  /** Ids launched this tick, in schedule order. */
  launched: string[];
  /** [X4] Ids whose slot was due but that the quota hold kept back; they stay due. */
  held?: string[];
}

/** `<profile>/cron/runs/<jobId>.jsonl` — one row per run, newest last. */
export function cronRunsPath(profileDir: string, jobId: string): string {
  return path.join(profileDir, "cron", "runs", `${jobId}.jsonl`);
}

/** Every recorded run of a job, oldest first; a missing file is an empty history. */
export function readCronRuns(profileDir: string, jobId: string, ioOverride?: Partial<ConfigIO>): CronRunRow[] {
  const io: ConfigIO = { ...NODE_IO, ...(ioOverride ?? {}) };
  const file = cronRunsPath(profileDir, jobId);
  if (!io.existsSync(file)) return [];
  return io
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as CronRunRow);
}

/** What the stream said, folded one event at a time: the consolidated brief, or the failure reason. */
interface Folded {
  summary: string | null;
  failed: boolean;
  costCents: number;
}

function fold(current: Folded, event: OrcEvent): Folded {
  const next = { ...current };
  if (event.kind === "step_end" && typeof event.step?.costCents === "number") next.costCents += event.step.costCents;
  switch (event.kind) {
    case "consolidate_end":
    case "run_done": {
      const summary = event.run?.summary;
      if (summary !== undefined && summary !== "") next.summary = summary;
      return next;
    }
    case "run_failed": {
      next.failed = true;
      if (event.detail !== undefined && event.detail !== "") next.summary = `Run failed: ${event.detail}`;
      else if (event.run?.summary !== undefined && event.run.summary !== "") next.summary = event.run.summary;
      return next;
    }
    default:
      return next;
  }
}

export class CronRunner {
  private readonly deps: CronRunnerDeps;
  private readonly io: ConfigIO;
  private readonly logger: StructuredLogger;
  private readonly historyLimit: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking: Promise<TickResult> | undefined;
  /** Set while started: this process's writer registration on the profile (`profile/locks.ts`). */
  private releaseWriter: (() => void) | undefined;

  constructor(deps: CronRunnerDeps) {
    this.deps = deps;
    this.io = { ...NODE_IO, ...(deps.io ?? {}) };
    this.historyLimit = deps.historyLimit ?? DEFAULT_HISTORY_LIMIT;
    this.logger = new StructuredLogger({ runId: "cron", stage: "cron.runner", ...(deps.log === undefined ? {} : { sink: deps.log }) });
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  /**
   * One pass over jobs.json. Every enabled job whose slot has arrived (or that the tool marked
   * `run_requested_at`) is stamped and rescheduled in a single atomic write, and only then run.
   * Overlapping ticks share the in-flight one, so a slow run never lets a slot fire twice.
   */
  public tick(): Promise<TickResult> {
    this.ticking ??= this.tickOnce().finally(() => {
      this.ticking = undefined;
    });
    return this.ticking;
  }

  private async tickOnce(): Promise<TickResult> {
    const now = this.now();
    const stamp = now.toISOString();
    const jobs = readCronJobs(this.deps.profileDir);
    const hold = this.quotaHold(now);
    const due: CronJob[] = [];
    const held: string[] = [];
    let changed = false;
    const next = jobs.map((job) => {
      if (!job.enabled) return job;
      if (job.next_run_at === undefined) {
        // First sight of this job: anchor it to its next slot rather than firing a stale one.
        changed = true;
        return { ...job, next_run_at: nextRun(job.schedule, now).toISOString() };
      }
      const slotDue = new Date(job.next_run_at).getTime() <= now.getTime();
      if (!slotDue && job.run_requested_at === undefined) return job;
      if (hold !== undefined && job.handler === undefined) {
        // [X4] Under a quota hold a prompt-driven job is neither stamped nor launched: its slot stays due.
        held.push(job.id);
        return job;
      }
      changed = true;
      const { run_requested_at: _requested, ...rest } = job;
      const rescheduled: CronJob = { ...rest, last_run_at: stamp, next_run_at: slotDue ? nextRun(job.schedule, now).toISOString() : job.next_run_at };
      due.push(rescheduled);
      return rescheduled;
    });
    if (changed) writeCronJobs(this.deps.profileDir, next, this.deps.io);
    if (hold !== undefined && held.length > 0) this.logHoldOnce(hold, held);
    for (const job of due) await this.execute(job, "scheduled", now);
    return { launched: due.map((j) => j.id), ...(held.length > 0 ? { held } : {}) };
  }

  /** [X4] The hold in force, clearing a stamp that has passed so the file says what the runner does. */
  private quotaHold(now: Date): Date | undefined {
    const state = readCronIncidents(this.deps.profileDir, this.deps.io);
    const until = quotaHoldUntil(state, now);
    if (until === undefined && state.quota_hold_until !== undefined) {
      const { quota_hold_until: _until, quota_hold_logged: _logged, ...rest } = state;
      writeCronIncidents(this.deps.profileDir, rest, this.deps.io);
    }
    return until;
  }

  /** One line per hold, not one per tick: the stamp already logged is kept in the book. */
  private logHoldOnce(until: Date, held: string[]): void {
    const state = readCronIncidents(this.deps.profileDir, this.deps.io);
    if (state.quota_hold_logged === state.quota_hold_until) return;
    this.logger.warn("cron.quota_hold", { until: until.toISOString(), heldJobs: held.length, jobIds: held.join(",") });
    writeCronIncidents(this.deps.profileDir, { ...state, quota_hold_logged: state.quota_hold_until }, this.deps.io);
  }

  /** `trent cron run <id>`: runs now, records a manual row, and leaves the schedule fields alone. */
  public async runNow(jobId: string): Promise<CronRunRow> {
    const job = readCronJobs(this.deps.profileDir).find((j) => j.id === jobId);
    if (!job) throw new TrentError({ code: EXIT.CONFIG, operation: "cron.run", message: "no scheduled job with that id; run `trent cron list`", target: jobId });
    return this.execute(job, "manual", this.now());
  }

  /** The last `last` rows of a job's history, oldest first. */
  public history(jobId: string, last = this.historyLimit): CronRunRow[] {
    const rows = readCronRuns(this.deps.profileDir, jobId, this.deps.io);
    return last >= rows.length ? rows : rows.slice(rows.length - last);
  }

  private async execute(job: CronJob, trigger: CronRunRow["trigger"], startedAt: Date): Promise<CronRunRow> {
    this.logger.info("cron.run.start", { jobId: job.id, trigger, schedule: job.schedule });
    let folded: Folded = { summary: null, failed: false, costCents: 0 };
    let threw: string | undefined;
    let thrown: unknown;
    try {
      if (job.handler !== undefined) {
        // [B1] A handled job: no prompt, no model; the handler's answer is the row.
        const handler = this.deps.handlers?.[job.handler];
        if (handler === undefined) throw new Error(`no handler named ${job.handler} is registered with this runner`);
        const answer = await handler(job, { now: startedAt, trigger });
        folded = { summary: answer.summary, failed: answer.failed === true, costCents: answer.costCents ?? 0 };
      } else {
        const input: CronRunOptions = { trigger: "scheduled", ...(job.model === undefined ? {} : { model: job.model }) };
        for await (const event of this.deps.run(job.prompt, input)) folded = fold(folded, event);
      }
    } catch (error) {
      thrown = error;
      threw = error instanceof Error ? error.message : String(error);
    }
    const endedAt = this.now();
    const failed = folded.failed || threw !== undefined;
    const row: CronRunRow = {
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      status: failed ? "failed" : "completed",
      trigger,
      summary: threw !== undefined ? `Run failed: ${threw}` : (folded.summary ?? ""),
      ...(folded.costCents > 0 ? { costCents: folded.costCents } : {}),
    };
    if (!failed && job.deliver !== undefined && row.summary !== "" && this.deps.deliver !== undefined) {
      try {
        await this.deps.deliver(job.deliver, row.summary, job);
      } catch (error) {
        row.deliveryError = error instanceof Error ? error.message : String(error);
        this.logger.error("cron.run.delivery_failed", { jobId: job.id, target: job.deliver, reason: row.deliveryError });
      }
    }
    this.appendHistory(job.id, row);
    const holdUntil = await this.book(job, trigger, row, thrown, endedAt);
    this.logger.log(failed ? "error" : "info", "cron.run.end", {
      jobId: job.id,
      trigger,
      status: row.status,
      durationMs: endedAt.getTime() - startedAt.getTime(),
      costCents: folded.costCents,
      delivered: job.deliver !== undefined && row.deliveryError === undefined && !failed,
      ...(threw === undefined ? {} : { reason: threw }),
      ...(holdUntil === undefined ? {} : { quotaHoldUntil: holdUntil }),
    });
    return row;
  }

  /**
   * [X4] The incident book after one run: a rate limit sets the hold whatever the trigger, a
   * scheduled failure counts on the streak and at the threshold sends the one alert, a success
   * ends the streak. Returns the hold this run set, for the log line.
   */
  private async book(job: CronJob, trigger: CronRunRow["trigger"], row: CronRunRow, thrown: unknown, at: Date): Promise<string | undefined> {
    const before = readCronIncidents(this.deps.profileDir, this.deps.io);
    let state: CronIncidentsState = before;
    let holdUntil: string | undefined;
    if (row.status === "failed") {
      const limit = rateLimitOf(thrown, row.summary, at);
      if (limit.limited) {
        state = recordRateLimit(state, at, limit.retryAfterMs, this.deps.quotaHoldMinutes ?? DEFAULT_QUOTA_HOLD_MINUTES);
        holdUntil = state.quota_hold_until;
      }
      if (trigger === "scheduled") {
        const outcome = recordFailure(state, job.id, row.summary, at, this.deps.failureAlertAfter ?? DEFAULT_FAILURE_ALERT_AFTER);
        state = outcome.state;
        if (outcome.opened !== undefined) state = markAlerted(state, job.id, await this.alertIncident(job, outcome.opened.failures, row.summary));
      }
    } else {
      state = recordSuccess(state, job.id);
    }
    if (state !== before) writeCronIncidents(this.deps.profileDir, state, this.deps.io);
    return holdUntil;
  }

  /** The one alert an incident gets; whether it left. Without an owner path there is nothing to send through. */
  private async alertIncident(job: CronJob, failures: number, summary: string): Promise<boolean> {
    this.logger.error("cron.incident.opened", { jobId: job.id, failures, reason: summary });
    if (this.deps.alert === undefined) {
      this.logger.warn("cron.incident.alert_failed", { jobId: job.id, reason: "no alert path is wired for this runner" });
      return false;
    }
    try {
      await this.deps.alert(failureAlertText(job, failures, summary));
      return true;
    } catch (error) {
      this.logger.error("cron.incident.alert_failed", { jobId: job.id, reason: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }

  /** Rewrites the file atomically with the newest `historyLimit` rows. */
  private appendHistory(jobId: string, row: CronRunRow): void {
    const file = cronRunsPath(this.deps.profileDir, jobId);
    if (!this.io.existsSync(path.dirname(file))) this.io.mkdirSync(path.dirname(file), { recursive: true });
    const rows = [...readCronRuns(this.deps.profileDir, jobId, this.deps.io), row].slice(-this.historyLimit);
    atomicWriteFileSync(this.io, file, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`, RUNS_FILE_MODE);
  }

  /** Takes the profile's runner lock and ticks every `intervalMs`. Refuses when another live runner holds it. */
  public start(): void {
    if (this.timer !== undefined) return;
    const lock = readCronRunnerLock(this.deps.profileDir, this.deps.io);
    if (lock !== null && cronRunnerActive(this.deps.profileDir, this.deps.io)) {
      throw new TrentError({
        code: EXIT.CONFIG,
        operation: "cron.start",
        message: `a cron runner is already running for this profile (pid ${lock.pid}); stop it before starting another`,
        target: cronRunnerLockPath(this.deps.profileDir),
      });
    }
    const file = cronRunnerLockPath(this.deps.profileDir);
    if (!this.io.existsSync(path.dirname(file))) this.io.mkdirSync(path.dirname(file), { recursive: true });
    atomicWriteFileSync(this.io, file, `${JSON.stringify({ pid: process.pid, started_at: this.now().toISOString() })}\n`, RUNS_FILE_MODE);
    // A ticking runner writes the profile (jobs.json, run history, the runs it launches), so it is a
    // live writer: `trent sessions prune` and the other maintenance commands refuse while it runs.
    this.releaseWriter = acquireProfileWriter(this.deps.profileDir, "cron");
    this.timer = setInterval(() => {
      this.tick().catch((error: unknown) => {
        this.logger.error("cron.tick.failed", { reason: error instanceof Error ? error.message : String(error) });
      });
    }, this.deps.intervalMs ?? DEFAULT_TICK_MS);
    this.logger.info("cron.runner.started", { pid: process.pid, intervalMs: this.deps.intervalMs ?? DEFAULT_TICK_MS });
  }

  /** Stops ticking and releases the lock. Idempotent. */
  public stop(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
    const file = cronRunnerLockPath(this.deps.profileDir);
    const lock = readCronRunnerLock(this.deps.profileDir, this.deps.io);
    if (lock?.pid === process.pid && this.io.existsSync(file)) this.io.unlinkSync(file);
    this.releaseWriter?.();
    this.releaseWriter = undefined;
    this.logger.info("cron.runner.stopped", { pid: process.pid });
  }

  public get running(): boolean {
    return this.timer !== undefined;
  }
}
