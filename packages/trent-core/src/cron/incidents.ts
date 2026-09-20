/**
 * [X4] The runner's incident book: `<profile>/cron/incidents.json`.
 *
 * Two things live here and nowhere else. Per job, the count of consecutive SCHEDULED failures and
 * the incident that count opened: at `failureAlertAfter` failures in a row the runner sends one
 * alert to the owner, marked `[CRON_FAILURE]`, and from then on every further failure is counted
 * on the open incident and never alerted, until `trent cron incidents ack <job>` closes it. A
 * completed run (scheduled or manual) clears the streak; it does not close the incident, because
 * the founder still has not seen it. Profile-wide, the quota hold: a provider 429 on any run
 * sets `quota_hold_until` from the server's `Retry-After` or the configured minutes, and until
 * then a tick launches no prompt-driven job. A handled job (no model in the loop) is unaffected.
 *
 * The file is separate from jobs.json so the tool's own rewrites of the schedule never touch a
 * count, and every write here is temp-file-then-rename at 0600 like the schedule's.
 */
import path from "node:path";
import { NODE_IO, atomicWriteFileSync, type ConfigIO } from "../config/atomic-fs.js";
import { classifyProviderError } from "../model-gateway/retry.js";

export const DEFAULT_FAILURE_ALERT_AFTER = 3;
export const DEFAULT_QUOTA_HOLD_MINUTES = 30;
/** The marker every failure alert carries, so a chat search or a filter finds them. */
export const CRON_FAILURE_MARKER = "[CRON_FAILURE]";
const INCIDENTS_FILE_MODE = 0o600;
const MS_PER_MINUTE = 60_000;

export interface CronIncident {
  readonly opened_at: string;
  readonly last_failure_at: string;
  /** The failed run's own summary, as the history row records it. */
  readonly last_summary: string;
  /** False when the alert could not be delivered; the incident is open either way. */
  readonly alerted: boolean;
}

export interface CronJobIncidentState {
  readonly failures: number;
  readonly incident?: CronIncident;
}

export interface CronIncidentsState {
  readonly version: 1;
  readonly jobs: Record<string, CronJobIncidentState>;
  readonly quota_hold_until?: string;
  /** The hold the runner already logged, so a hold is logged once and not once per tick. */
  readonly quota_hold_logged?: string;
}

/** One open incident as `trent cron incidents` lists it. */
export interface OpenIncident extends CronIncident {
  readonly jobId: string;
  readonly failures: number;
}

const EMPTY: CronIncidentsState = { version: 1, jobs: {} };

export function cronIncidentsPath(profileDir: string): string {
  return path.join(profileDir, "cron", "incidents.json");
}

export function readCronIncidents(profileDir: string, ioOverride?: Partial<ConfigIO>): CronIncidentsState {
  const io: ConfigIO = { ...NODE_IO, ...(ioOverride ?? {}) };
  const file = cronIncidentsPath(profileDir);
  if (!io.existsSync(file)) return EMPTY;
  try {
    const parsed = JSON.parse(io.readFileSync(file, "utf8")) as Partial<CronIncidentsState>;
    return { ...EMPTY, ...parsed, jobs: parsed.jobs !== undefined && typeof parsed.jobs === "object" ? parsed.jobs : {} };
  } catch {
    return EMPTY;
  }
}

export function writeCronIncidents(profileDir: string, state: CronIncidentsState, ioOverride?: Partial<ConfigIO>): void {
  const io: ConfigIO = { ...NODE_IO, ...(ioOverride ?? {}) };
  const file = cronIncidentsPath(profileDir);
  if (!io.existsSync(path.dirname(file))) io.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteFileSync(io, file, `${JSON.stringify(state, null, 2)}\n`, INCIDENTS_FILE_MODE);
}

/** Every open incident, oldest first. */
export function openIncidents(profileDir: string, ioOverride?: Partial<ConfigIO>): OpenIncident[] {
  const state = readCronIncidents(profileDir, ioOverride);
  return Object.entries(state.jobs)
    .filter((entry): entry is [string, CronJobIncidentState & { incident: CronIncident }] => entry[1].incident !== undefined)
    .map(([jobId, job]) => ({ jobId, failures: job.failures, ...job.incident }))
    .sort((a, b) => a.opened_at.localeCompare(b.opened_at));
}

/** `trent cron incidents ack <job>`: closes the incident and resets the count. Undefined when none is open. */
export function acknowledgeIncident(profileDir: string, jobId: string, by: string, at: Date, ioOverride?: Partial<ConfigIO>): (OpenIncident & { acknowledged_by: string; acknowledged_at: string }) | undefined {
  const state = readCronIncidents(profileDir, ioOverride);
  const job = state.jobs[jobId];
  if (job?.incident === undefined) return undefined;
  const { [jobId]: _closed, ...rest } = state.jobs;
  writeCronIncidents(profileDir, { ...state, jobs: rest }, ioOverride);
  return { jobId, failures: job.failures, ...job.incident, acknowledged_by: by, acknowledged_at: at.toISOString() };
}

/** The hold in force at `now`, or undefined; a stale stamp is not a hold. */
export function quotaHoldUntil(state: CronIncidentsState, now: Date): Date | undefined {
  if (state.quota_hold_until === undefined) return undefined;
  const until = new Date(state.quota_hold_until);
  return Number.isNaN(until.getTime()) || until.getTime() <= now.getTime() ? undefined : until;
}

/**
 * Whether a failed run was a provider rate limit, and for how long the provider asked us to wait.
 * A thrown error is classified the way the model gateway classifies it (status and `Retry-After`);
 * a failure the run's event stream reported is a string, and the gateway's own error message is
 * the only place a status appears in it.
 */
export function rateLimitOf(thrown: unknown, detail: string | undefined, now: Date): { limited: boolean; retryAfterMs?: number } {
  if (thrown !== undefined) {
    const classified = classifyProviderError(thrown, now.getTime());
    if (classified.errorClass === "rate_limit") return { limited: true, ...(classified.retryAfterMs === undefined ? {} : { retryAfterMs: classified.retryAfterMs }) };
  }
  return { limited: /\bHTTP 429\b/.test(detail ?? "") };
}

export interface FailureOutcome {
  readonly state: CronIncidentsState;
  /** Set exactly when this failure opened the incident: the alert to send. */
  readonly opened?: { readonly failures: number };
}

/** A scheduled failure: one more on the streak, and the incident it opens at the threshold. */
export function recordFailure(state: CronIncidentsState, jobId: string, summary: string, at: Date, alertAfter: number): FailureOutcome {
  const current = state.jobs[jobId] ?? { failures: 0 };
  const failures = current.failures + 1;
  const stamp = at.toISOString();
  if (current.incident !== undefined) {
    const incident: CronIncident = { ...current.incident, last_failure_at: stamp, last_summary: summary };
    return { state: { ...state, jobs: { ...state.jobs, [jobId]: { failures, incident } } } };
  }
  if (failures < alertAfter) return { state: { ...state, jobs: { ...state.jobs, [jobId]: { failures } } } };
  const incident: CronIncident = { opened_at: stamp, last_failure_at: stamp, last_summary: summary, alerted: false };
  return { state: { ...state, jobs: { ...state.jobs, [jobId]: { failures, incident } } }, opened: { failures } };
}

export function markAlerted(state: CronIncidentsState, jobId: string, alerted: boolean): CronIncidentsState {
  const job = state.jobs[jobId];
  if (job?.incident === undefined) return state;
  return { ...state, jobs: { ...state.jobs, [jobId]: { ...job, incident: { ...job.incident, alerted } } } };
}

/** A completed run: the streak is over; an open incident stays until it is acknowledged. */
export function recordSuccess(state: CronIncidentsState, jobId: string): CronIncidentsState {
  const job = state.jobs[jobId];
  if (job === undefined) return state;
  if (job.incident === undefined) {
    const { [jobId]: _cleared, ...rest } = state.jobs;
    return { ...state, jobs: rest };
  }
  return { ...state, jobs: { ...state.jobs, [jobId]: { ...job, failures: 0 } } };
}

/** A 429: hold every prompt-driven job until the later of the current hold and the new one. */
export function recordRateLimit(state: CronIncidentsState, at: Date, retryAfterMs: number | undefined, holdMinutes: number): CronIncidentsState {
  const untilMs = at.getTime() + (retryAfterMs ?? holdMinutes * MS_PER_MINUTE);
  const current = quotaHoldUntil(state, at);
  if (current !== undefined && current.getTime() >= untilMs) return state;
  return { ...state, quota_hold_until: new Date(untilMs).toISOString() };
}

/** The alert text for an incident that just opened. */
export function failureAlertText(job: { id: string; name: string }, failures: number, summary: string): string {
  return `${CRON_FAILURE_MARKER} scheduled job ${job.id} (${job.name}) has failed ${failures} times in a row. Last failure: ${summary} Further failures are counted, not repeated here; acknowledge with trent cron incidents ack ${job.id}.`;
}
