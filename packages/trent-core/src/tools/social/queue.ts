/**
 * The post queue on the CLI's own job file (`<profile>/cron/jobs.json`, docs/cron.md) with
 * approval rows, not the app's calendar (its `assertPublishingAllowed` needs a web-only
 * `autoPublishEnabled` flag, `apps/web/lib/social/calendar.ts`).
 *
 * At queue time `social_schedule` shows the human exactly what will be published and when, and
 * binds the approval to that call (`governance/bound-approvals.ts`); only a granted call writes
 * the job. The job carries `handler: social_publish` and the approved call as its payload, and a
 * one-shot schedule (minute, hour, day, month, in UTC as every cron expression here is) anchored
 * by `next_run_at`, so the runner's first sight of it does not skip the slot. At tick time
 * `trent cron` hands the job to {@link createSocialPublishHandler}, which re-checks the same
 * approval row, publishes through the idempotent path keyed on that same call so a rerun answers
 * from the store, and disables the job. No model is in the loop after the approval.
 */
import type { CronJobHandler } from "../../cron/CronRunner.js";
import { IdempotencyManager } from "../../governance/IdempotencyManager.js";
import { boundCallKey, createBoundApprovalStore, requireBoundApproval, type BoundApprovalStore, type BoundCall } from "../../governance/bound-approvals.js";
import { newCronJob, readCronJobs, runnerNote, writeCronJobs, type CronJob } from "../cron/index.js";
import { createSocialPorts, publishSocialPost, type PublishResult, type SocialAdapterOptions } from "./publish.js";
import { SocialToolError, type SocialPostRequest } from "./types.js";

export const SOCIAL_PUBLISH_HANDLER = "social_publish";
/** A queued time may be at most this far ahead: a five-field cron expression carries no year. */
export const MAX_QUEUE_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;

/** `job.payload` of a queued post: the approved call, what the human saw, and what it asks for. */
export interface SocialQueueEntry extends Record<string, unknown> {
  readonly call: BoundCall;
  readonly preview: string;
  readonly request: SocialPostRequest;
  readonly at: string;
  published?: { readonly externalId: string; readonly route: string; readonly at: string };
}

/** The time as a one-shot cron expression: that minute, hour, day and month, any weekday, in UTC. */
export function oneShotCron(at: Date): string {
  return `${at.getUTCMinutes()} ${at.getUTCHours()} ${at.getUTCDate()} ${at.getUTCMonth() + 1} *`;
}

/** The instant the runner will fire it: the requested time with seconds dropped, as cron slots are whole minutes. */
export function queueSlot(at: Date): Date {
  const slot = new Date(at.getTime());
  slot.setUTCSeconds(0, 0);
  return slot;
}

export function parseQueueTime(raw: string | undefined, now: Date): Date {
  if (raw === undefined || raw.trim() === "") throw new SocialToolError("social_schedule_time_required", "social_schedule needs at: an ISO 8601 time with a zone, such as 2026-10-01T15:00:00Z");
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) throw new SocialToolError("social_schedule_time_invalid", `at is not an ISO 8601 time: ${raw}`);
  if (queueSlot(at).getTime() <= now.getTime()) throw new SocialToolError("social_schedule_time_past", `at ${at.toISOString()} is not after now (${now.toISOString()}); use social_post to publish now`);
  if (at.getTime() - now.getTime() > MAX_QUEUE_AHEAD_MS) throw new SocialToolError("social_schedule_time_far", `at ${at.toISOString()} is more than a year ahead`);
  return at;
}

/** Writes the approved post as a handled one-shot job. The caller has already been granted `entry.call`. */
export function queueSocialPost(profileDir: string, entry: SocialQueueEntry, now: Date): CronJob {
  const at = new Date(entry.at);
  const slot = queueSlot(at);
  const job: CronJob = {
    ...newCronJob({ name: `social post: ${entry.request.platform} at ${slot.toISOString()}`, schedule: oneShotCron(slot), prompt: `Publish the approved ${entry.request.platform} post queued for ${slot.toISOString()}` }, now.toISOString()),
    handler: SOCIAL_PUBLISH_HANDLER,
    payload: entry,
    next_run_at: slot.toISOString(),
  };
  writeCronJobs(profileDir, [...readCronJobs(profileDir), job]);
  return job;
}

export function queuedSummary(job: CronJob, entry: SocialQueueEntry, profileDir: string): string {
  return `queued ${job.id}: ${entry.preview}. It publishes once when the cron runner ticks past ${job.next_run_at}; trent cron list shows it and trent cron remove ${job.id} withdraws it. ${runnerNote(profileDir)}`;
}

function entryOf(job: CronJob): SocialQueueEntry {
  const payload = job.payload as Partial<SocialQueueEntry> | undefined;
  if (payload?.call === undefined || typeof payload.preview !== "string" || payload.request === undefined || typeof payload.at !== "string") {
    throw new SocialToolError("social_queue_payload_invalid", `job ${job.id} carries no queued social post`);
  }
  return payload as SocialQueueEntry;
}

function patchJob(profileDir: string, id: string, patch: Partial<CronJob>, now: Date): void {
  const jobs = readCronJobs(profileDir).map((job) => (job.id === id ? { ...job, ...patch, updated_at: now.toISOString() } : job));
  writeCronJobs(profileDir, jobs);
}

export interface SocialPublishHandlerDeps {
  readonly profileDir: string;
  readonly social?: SocialAdapterOptions;
  /** Defaults to the profile's `gateway.json` rows, the ones `trent approvals` decides. */
  readonly bindings?: BoundApprovalStore;
  /** Defaults to the profile's `idempotency.json`. */
  readonly idempotency?: IdempotencyManager;
  readonly seat?: string;
}

/** The tick-time publisher `trent cron` registers under {@link SOCIAL_PUBLISH_HANDLER}. */
export function createSocialPublishHandler(deps: SocialPublishHandlerDeps): CronJobHandler {
  const bindings = deps.bindings ?? createBoundApprovalStore({ profileDir: deps.profileDir });
  const idempotency = deps.idempotency ?? new IdempotencyManager({ dir: deps.profileDir });
  return async (job, { now }) => {
    const entry = entryOf(job);
    const decision = requireBoundApproval(entry.call, entry.preview, bindings);
    if (!decision.granted) {
      // A denial ends the job; a still-pending row keeps it, for `trent approvals approve` then `trent cron run`.
      if (decision.row?.status === "denied") patchJob(deps.profileDir, job.id, { enabled: false }, now);
      return { failed: true, summary: `${decision.record.summary} The queued post was not published${decision.row?.status === "denied" ? " and the job is disabled" : `; approve it, then run trent cron run ${job.id}`}.` };
    }
    const ports = createSocialPorts(deps.profileDir, { ...deps.social, now: deps.social?.now ?? (() => now) });
    try {
      const outcome = await idempotency.executeWithIdempotency<PublishResult>(boundCallKey(entry.call), "generic", () => publishSocialPost(entry.request, ports, deps.seat));
      const result = outcome.result;
      patchJob(deps.profileDir, job.id, { enabled: false, payload: { ...entry, published: { externalId: result.externalId, route: result.route, at: now.toISOString() } } }, now);
      const repeat = outcome.cached === true ? " (already published; answered from the idempotency store, nothing was sent again)" : "";
      return { summary: `published ${entry.request.platform} post ${result.externalId} via ${result.route}${repeat}${result.note === undefined ? "" : `. ${result.note}`}` };
    } catch (error) {
      const message = error instanceof SocialToolError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error);
      return { failed: true, summary: `queued ${entry.request.platform} post ${job.id} was not published: ${message}` };
    }
  };
}
