/**
 * [X4] Editing the post queue on the job file: `trent cron queue list|edit|rm|move`.
 *
 * A queued post is a handled job (`handler: social_publish`, `tools/social/queue.ts`) whose
 * payload carries the call a human approved and the preview they saw; at tick time the publish
 * handler re-checks that exact call against the profile's approval rows. So the rule for every
 * write here follows from the binding, not from a policy of its own:
 *
 *   - An edit that changes what would leave the machine (text, media, account, platform) is a
 *     different call. The rows bound to the old call are expired, the new call is previewed
 *     through the social adapter's own dry run (the same refusals `social_schedule` gives) and
 *     parked as a FRESH pending row: `trent approvals approve <id>` grants exactly the new content.
 *     A row is never reused, even for content that was approved once before.
 *   - [P2-14] An edit keeps the post's files unless it names a media URL (a post carries files or
 *     one URL, not both). The files are re-read through that same dry run in the workspace they
 *     were approved under, and the edit is refused, leaving the job alone, unless each one is
 *     still the file that was approved (its line, digest prefix included, on the new card).
 *   - A move changes only when the post leaves. The call is unchanged, so the approval stands;
 *     the one-shot schedule and `next_run_at` are re-anchored the way queueing anchors them.
 *   - Removing a queued post removes its pending row, and expires an approved one so that the
 *     same call, queued again, asks again.
 *
 * Not re-exported from `./index.js`: the social toolset imports the job file's helpers from
 * there, and this module imports the social toolset, so the CLI reaches it by its own path.
 */
import path from "node:path";
import { EXIT, TrentError } from "../../errors/index.js";
import { FileGatewayStore, type ApprovalRow, type GatewayStore } from "../../gateway/store/GatewayStore.js";
import { boundCallKey, createBoundApprovalStore, type BoundApprovalRow, type BoundCall } from "../../governance/bound-approvals.js";
import { SOCIAL_ADAPTER_NAME, SOCIAL_WRITE_CLASSES, createSocialAdapter, type SocialAdapterOptions } from "../social/index.js";
import { describeMediaFile, type SocialMediaFile } from "../social/media-files.js";
import { SOCIAL_PUBLISH_HANDLER, oneShotCron, parseQueueTime, queueSlot, type SocialQueueEntry } from "../social/queue.js";
import { SocialToolError, type SocialPostRequest } from "../social/types.js";
import { readCronJobs, writeCronJobs, type CronJob } from "./index.js";

const SCHEDULE_TOOL = "social_schedule";

export interface QueueEditDeps {
  readonly profileDir: string;
  /** The approval rows; defaults to the profile's `gateway.json`, the ones `trent approvals` decides. */
  readonly store?: GatewayStore;
  readonly now?: () => Date;
  /** How the social adapter is built for the preview and its refusals; the CLI passes its config manager. */
  readonly social?: SocialAdapterOptions;
}

export type QueueApprovalState = ApprovalRow["status"] | "none";

/** One file a queued post attaches, as the list names it: the path the call gave and its size. */
export interface QueuedFileRow {
  readonly path: string;
  readonly bytes: number;
}

/** One queued post as `trent cron queue list` shows it. */
export interface QueuedPostRow {
  readonly id: string;
  readonly name: string;
  readonly platform: string;
  readonly text: string;
  readonly mediaUrl?: string;
  readonly media?: readonly QueuedFileRow[];
  readonly accountId?: string;
  readonly at: string;
  readonly enabled: boolean;
  readonly approval: QueueApprovalState;
  readonly approvalId?: string;
  readonly published?: SocialQueueEntry["published"];
}

export interface QueueEditPatch {
  readonly text?: string | undefined;
  readonly mediaUrl?: string | undefined;
  readonly accountId?: string | undefined;
  readonly platform?: string | undefined;
}

export interface QueueEditResult {
  readonly id: string;
  readonly changed: boolean;
  /** The row the post now depends on: the fresh pending one after a change, the standing one otherwise. */
  readonly approval: BoundApprovalRow | undefined;
}

function fail(operation: string, message: string, target: string): never {
  throw new TrentError({ code: EXIT.CONFIG, operation, message, target });
}

function entryOf(job: CronJob, operation: string): SocialQueueEntry {
  if (job.handler !== SOCIAL_PUBLISH_HANDLER) fail(operation, "that job is not a queued post; trent cron remove withdraws a scheduled job", job.id);
  const payload = job.payload as Partial<SocialQueueEntry> | undefined;
  if (payload?.call === undefined || typeof payload.preview !== "string" || payload.request === undefined || typeof payload.at !== "string") {
    fail(operation, "that job carries no queued social post", job.id);
  }
  return payload as SocialQueueEntry;
}

function findQueued(deps: QueueEditDeps, operation: string, id: string): { jobs: CronJob[]; job: CronJob; entry: SocialQueueEntry } {
  const jobs = readCronJobs(deps.profileDir);
  const job = jobs.find((j) => j.id === id);
  if (job === undefined) fail(operation, "no queued post with that id; run trent cron queue list", id);
  return { jobs, job, entry: entryOf(job, operation) };
}

function storeOf(deps: QueueEditDeps): GatewayStore {
  return deps.store ?? new FileGatewayStore(path.join(deps.profileDir, "gateway.json"));
}

const now = (deps: QueueEditDeps): Date => (deps.now ?? (() => new Date()))();

/** The newest row bound to `call`, whatever its status. */
function rowFor(store: GatewayStore, call: BoundCall): BoundApprovalRow | undefined {
  return createBoundApprovalStore({ store }).find(call);
}

/** Every row bound to `call` that still says something, expired in place. */
function expireRows(store: GatewayStore, call: BoundCall): void {
  const key = boundCallKey(call);
  store.mutate((state) => {
    for (const row of Object.values(state.approvals)) {
      if ((row.details as { key?: unknown }).key === key && row.status !== "expired") row.status = "expired";
    }
    return undefined;
  });
}

function sameFiles(a: readonly SocialMediaFile[] | undefined, b: readonly SocialMediaFile[] | undefined): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

function sameRequest(a: SocialPostRequest, b: SocialPostRequest): boolean {
  return a.platform === b.platform && a.text === b.text && a.mediaUrl === b.mediaUrl && sameFiles(a.media, b.media) && a.accountId === b.accountId;
}

/** The deepest directory holding every path, or undefined when only the filesystem root does. */
function commonDir(paths: readonly string[]): string | undefined {
  let dir = path.dirname(paths[0] ?? "/");
  while (!paths.every((p) => p.startsWith(`${dir}${path.sep}`))) {
    if (path.dirname(dir) === dir) return undefined;
    dir = path.dirname(dir);
  }
  return path.dirname(dir) === dir ? undefined : dir;
}

/**
 * The workspace a queued post's files were resolved under, recovered from what the approval
 * recorded: each file's real path is that workspace joined with the path the call named. The
 * queue keeps no workspace of its own, and the CLI's is the profile, where the files are not.
 */
function approvedWorkspace(files: readonly SocialMediaFile[]): string | undefined {
  const roots = new Set<string>();
  for (const file of files) {
    if (path.isAbsolute(file.path)) continue;
    const named = path.normalize(file.path);
    if (!file.file.endsWith(`${path.sep}${named}`)) return undefined;
    roots.add(file.file.slice(0, file.file.length - named.length - 1));
  }
  if (roots.size > 1) return undefined;
  return roots.size === 1 ? [...roots][0] : commonDir(files.map((file) => file.file));
}

function jobName(platform: string, slot: Date): string {
  return `social post: ${platform} at ${slot.toISOString()}`;
}

function jobPrompt(platform: string, slot: Date): string {
  return `Publish the approved ${platform} post queued for ${slot.toISOString()}`;
}

export function listQueuedPosts(deps: QueueEditDeps): QueuedPostRow[] {
  const store = storeOf(deps);
  const rows: QueuedPostRow[] = [];
  for (const job of readCronJobs(deps.profileDir)) {
    if (job.handler !== SOCIAL_PUBLISH_HANDLER) continue;
    const payload = job.payload as Partial<SocialQueueEntry> | undefined;
    if (payload?.call === undefined || payload.request === undefined || typeof payload.at !== "string") continue;
    const row = rowFor(store, payload.call);
    rows.push({
      id: job.id,
      name: job.name,
      platform: payload.request.platform,
      text: payload.request.text,
      ...(payload.request.mediaUrl === undefined ? {} : { mediaUrl: payload.request.mediaUrl }),
      ...(payload.request.media === undefined || payload.request.media.length === 0 ? {} : { media: payload.request.media.map((file) => ({ path: file.path, bytes: file.bytes })) }),
      ...(payload.request.accountId === undefined ? {} : { accountId: payload.request.accountId }),
      at: new Date(payload.at).toISOString(),
      enabled: job.enabled,
      approval: row?.status ?? "none",
      ...(row === undefined ? {} : { approvalId: row.id }),
      ...(payload.published === undefined ? {} : { published: payload.published }),
    });
  }
  return rows.sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * The edited post through the social adapter's own dry run: its preview, or its refusal as a config
 * error. `workspace` is where the post's files resolve; a post without files needs none.
 */
async function previewEdited(deps: QueueEditDeps, action: string, id: string, workspace = deps.profileDir): Promise<string> {
  const adapter = createSocialAdapter({ workspace, profileDir: deps.profileDir, backend: "local" }, { ...(deps.social ?? {}), now: deps.social?.now ?? (() => now(deps)) });
  const dry = await adapter.dryRun!(action, {});
  if (dry.status !== "needs_approval") fail("cron.queue.edit", `the social toolset refused the edited post: ${dry.summary}`, id);
  const preview = adapter.preview?.(action);
  if (preview === undefined) fail("cron.queue.edit", "the social toolset gave no preview for the edited post", id);
  return preview;
}

export async function editQueuedPost(deps: QueueEditDeps, id: string, patch: QueueEditPatch): Promise<QueueEditResult> {
  const { jobs, job, entry } = findQueued(deps, "cron.queue.edit", id);
  if (entry.published !== undefined) fail("cron.queue.edit", `that post already published as ${entry.published.externalId}; queue a new one`, id);
  const store = storeOf(deps);
  // The files stay unless the edit names a media URL, which replaces them.
  const media = patch.mediaUrl === undefined && entry.request.media !== undefined && entry.request.media.length > 0 ? entry.request.media : undefined;
  const request: SocialPostRequest = {
    platform: (patch.platform ?? entry.request.platform) as SocialPostRequest["platform"],
    text: patch.text ?? entry.request.text,
    ...((patch.mediaUrl ?? entry.request.mediaUrl) === undefined ? {} : { mediaUrl: patch.mediaUrl ?? entry.request.mediaUrl }),
    ...(media === undefined ? {} : { media }),
    ...((patch.accountId ?? entry.request.accountId) === undefined ? {} : { accountId: patch.accountId ?? entry.request.accountId }),
  };
  if (sameRequest(request, entry.request)) return { id, changed: false, approval: rowFor(store, entry.call) };

  const at = new Date(entry.at).toISOString();
  const args = {
    platform: request.platform,
    text: request.text,
    ...(media === undefined ? {} : { media: media.map((file) => ({ path: file.path, alt: file.alt })) }),
    ...(request.mediaUrl === undefined ? {} : { media_url: request.mediaUrl }),
    ...(request.accountId === undefined ? {} : { account_id: request.accountId }),
    at,
  };
  const action = `${SCHEDULE_TOOL} ${JSON.stringify(args)}`;
  const workspace = media === undefined ? undefined : approvedWorkspace(media);
  if (media !== undefined && workspace === undefined) {
    fail("cron.queue.edit", "the post's files cannot be traced back to the workspace they were approved in; remove the post and queue it again", id);
  }
  const preview = await previewEdited(deps, action, id, workspace);
  for (const file of media ?? []) {
    if (!preview.includes(describeMediaFile(file))) {
      fail("cron.queue.edit", `social_media_changed: ${file.path} is not the file that was approved (${describeMediaFile(file)}); nothing was edited. Save the new file under a new name and queue the post again`, id);
    }
  }
  // Outside a seat turn: no run, no step, so nothing is implicit and only a human's decision grants it.
  const call: BoundCall = { adapter: SOCIAL_ADAPTER_NAME, action, tool: SCHEDULE_TOOL, args, classes: SOCIAL_WRITE_CLASSES, ...(entry.call.seat === undefined ? {} : { seat: entry.call.seat }) };

  expireRows(store, entry.call);
  expireRows(store, call);
  const decision = createBoundApprovalStore({ store }).require(call, preview);
  const approval = decision.row;
  const stamp = now(deps).toISOString();
  const next: CronJob = { ...job, payload: { ...entry, call, preview, request }, updated_at: stamp };
  writeCronJobs(deps.profileDir, jobs.map((j) => (j.id === id ? next : j)));
  return { id, changed: true, approval };
}

export interface QueueMoveResult {
  readonly id: string;
  readonly at: string;
  readonly enabled: boolean;
  readonly approval: BoundApprovalRow | undefined;
}

export function moveQueuedPost(deps: QueueEditDeps, id: string, when: string): QueueMoveResult {
  const { jobs, job, entry } = findQueued(deps, "cron.queue.move", id);
  if (entry.published !== undefined) fail("cron.queue.move", `that post already published as ${entry.published.externalId}; queue a new one`, id);
  let at: Date;
  try {
    at = parseQueueTime(when, now(deps));
  } catch (error) {
    if (error instanceof SocialToolError) fail("cron.queue.move", `${error.code}: ${error.message}`, id);
    throw error;
  }
  const slot = queueSlot(at);
  const stamp = now(deps).toISOString();
  const next: CronJob = {
    ...job,
    name: jobName(entry.request.platform, slot),
    prompt: jobPrompt(entry.request.platform, slot),
    schedule: oneShotCron(slot),
    next_run_at: slot.toISOString(),
    payload: { ...entry, at: at.toISOString() },
    updated_at: stamp,
  };
  writeCronJobs(deps.profileDir, jobs.map((j) => (j.id === id ? next : j)));
  return { id, at: slot.toISOString(), enabled: next.enabled, approval: rowFor(storeOf(deps), entry.call) };
}

export interface QueueRemoveResult {
  readonly id: string;
  /** What happened to the row bound to the post's call. */
  readonly approval: "removed" | "expired" | "none";
  readonly count: number;
}

export function removeQueuedPost(deps: QueueEditDeps, id: string): QueueRemoveResult {
  const { jobs, entry } = findQueued(deps, "cron.queue.rm", id);
  const store = storeOf(deps);
  const key = boundCallKey(entry.call);
  const approval = store.mutate((state): QueueRemoveResult["approval"] => {
    let outcome: QueueRemoveResult["approval"] = "none";
    for (const [rowId, row] of Object.entries(state.approvals)) {
      if ((row.details as { key?: unknown }).key !== key) continue;
      if (row.status === "pending") {
        delete state.approvals[rowId];
        outcome = "removed";
      } else if (row.status === "approved") {
        row.status = "expired";
        if (outcome !== "removed") outcome = "expired";
      }
    }
    return outcome;
  });
  const remaining = jobs.filter((j) => j.id !== id);
  writeCronJobs(deps.profileDir, remaining);
  return { id, approval, count: remaining.length };
}
