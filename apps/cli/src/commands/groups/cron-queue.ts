/**
 * [X4] The `cron incidents` and `cron queue` groups, registered under `cron` (`./cron.ts`).
 *
 * `incidents` reads the runner's incident book (`<profile>/cron/incidents.json`): the jobs whose
 * consecutive failures crossed `cron.failure_alert_after` and were alerted once, and the quota
 * hold a provider 429 set. `ack <job>` closes one and resets its count, which is what lets the
 * next streak alert again. `queue` edits the post queue on the job file through
 * `tools/cron/queue-edit.ts`, where the approval rule lives: a changed post re-asks with a fresh
 * row, a move keeps the approval, `rm` removes the job and its pending row.
 *
 * Every id subcommand under `--dry-run` answers `{ dryRun, command, id }` at exit 0 and reads
 * nothing, the convention the registry probe checks.
 */
import { acknowledgeIncident, openIncidents, quotaHoldUntil, readCronIncidents, type OpenIncident } from "@trent/core/cron/index.js";
import { EXIT, TrentError } from "@trent/core/errors/index.js";
import { editQueuedPost, listQueuedPosts, moveQueuedPost, removeQueuedPost, type QueueEditDeps, type QueuedPostRow } from "@trent/core/tools/cron/queue-edit.js";
import type { BoundApprovalRow } from "@trent/core/governance/index.js";
import type { CommandContext } from "../context.js";
import type { CommandSpec } from "../registry.js";

const dry = (command: string, id: string, extra: Record<string, unknown> = {}) => ({ data: { dryRun: true, command, id, ...extra } });

function profileDir(ctx: CommandContext): string {
  return ctx.config().getProfileDir();
}

function nowOf(ctx: CommandContext): Date {
  return (ctx.overrides.now ?? (() => new Date()))();
}

function optionalString(opts: Record<string, unknown>, key: string): string | undefined {
  const value = typeof opts[key] === "string" ? opts[key].trim() : "";
  return value.length > 0 ? value : undefined;
}

/** What a queued post's row is reduced to on the wire: enough to approve it, never the whole row. */
function approvalOf(row: BoundApprovalRow | undefined): { id: string; status: string; preview: string } | null {
  return row === undefined ? null : { id: row.id, status: row.status, preview: row.details.preview };
}

function queueDeps(ctx: CommandContext): QueueEditDeps {
  return { profileDir: profileDir(ctx), now: () => nowOf(ctx), social: { manager: ctx.config() } };
}

function incidentLine(incident: OpenIncident, ctx: CommandContext): string {
  const alerted = incident.alerted ? ctx.theme.meta("alerted") : ctx.theme.meta("not alerted");
  return `  ${ctx.theme.value(incident.jobId)} ${ctx.theme.meta(`${String(incident.failures)} failures since ${incident.opened_at}`)} ${alerted}\n    ${ctx.theme.body(incident.last_summary)}`;
}

function postLine(post: QueuedPostRow, ctx: CommandContext): string {
  const state = post.published !== undefined ? ctx.theme.success("published") : post.enabled ? ctx.theme.success("queued   ") : ctx.theme.meta("disabled ");
  // [P2-14] Each file the post attaches, by the path the call named and its size.
  const files = post.media === undefined || post.media.length === 0 ? "" : `\n    ${ctx.theme.meta(`files: ${post.media.map((file) => `${file.path} (${file.bytes.toLocaleString("en-US")} bytes)`).join(", ")}`)}`;
  return `  ${state} ${ctx.theme.value(post.id)} ${ctx.theme.meta(post.at)} ${ctx.theme.meta(post.platform.padEnd(9, " "))} ${ctx.theme.meta(`approval ${post.approval}`)}\n    ${ctx.theme.body(post.text)}${files}`;
}

function listIncidents(ctx: CommandContext) {
  const state = readCronIncidents(profileDir(ctx));
  const hold = quotaHoldUntil(state, nowOf(ctx));
  return { data: { incidents: openIncidents(profileDir(ctx)), quotaHoldUntil: hold === undefined ? null : hold.toISOString() } };
}

function renderIncidents(data: unknown, ctx: CommandContext): string[] {
  const d = data as { incidents: OpenIncident[]; quotaHoldUntil: string | null };
  const lines = [ctx.theme.emphasis(`OPEN CRON INCIDENTS (${d.incidents.length})`)];
  for (const incident of d.incidents) lines.push(incidentLine(incident, ctx));
  if (d.incidents.length === 0) lines.push(ctx.theme.meta("  none; a job alerts once after cron.failure_alert_after consecutive failures"));
  if (d.quotaHoldUntil !== null) lines.push(`  ${ctx.theme.meta("quota hold")} ${ctx.theme.value(d.quotaHoldUntil)} ${ctx.theme.meta("prompt-driven jobs wait until then after a provider 429")}`);
  if (d.incidents.length > 0) lines.push(ctx.theme.meta("  trent cron incidents ack <job> closes one and lets its next streak alert again"));
  return lines;
}

export const cronIncidentsSpec: CommandSpec = {
  name: "incidents",
  description: "Open failure incidents (one alert per streak of cron.failure_alert_after failures) and the quota hold",
  run: (ctx) => listIncidents(ctx),
  render: renderIncidents,
  subcommands: [
    {
      name: "list",
      description: "List open incidents and the quota hold",
      run: (ctx) => listIncidents(ctx),
      render: renderIncidents,
    },
    {
      name: "ack <job>",
      description: "Close a job's incident and reset its failure count, so its next streak alerts again",
      run(ctx, _opts, args) {
        const id = String(args[0]);
        if (ctx.dryRun) return dry("cron incidents ack", id);
        const acknowledged = acknowledgeIncident(profileDir(ctx), id, "trent cron incidents ack", nowOf(ctx));
        if (acknowledged === undefined) {
          throw new TrentError({ code: EXIT.CONFIG, operation: "cron.incidents.ack", message: "no open incident for that job; run `trent cron incidents`", target: id });
        }
        return { data: { acknowledged } };
      },
      render(data, ctx) {
        const d = data as { dryRun?: boolean; id?: string; acknowledged?: OpenIncident };
        if (d.dryRun === true) return [`  ${ctx.theme.meta("would acknowledge")} ${ctx.theme.value(String(d.id))}`];
        return d.acknowledged ? [`  ${ctx.theme.success("acknowledged")} ${ctx.theme.value(d.acknowledged.jobId)} ${ctx.theme.meta(`after ${String(d.acknowledged.failures)} failures`)}`] : [];
      },
    },
  ],
};

export const cronQueueSpec: CommandSpec = {
  name: "queue",
  description: "The post queue on the job file: list, edit, move or remove a queued social post",
  subcommands: [
    {
      name: "list",
      description: "List queued posts with their approval state and each attached file's size",
      run: (ctx) => ({ data: { posts: listQueuedPosts(queueDeps(ctx)) } }),
      render(data, ctx) {
        const d = data as { posts: QueuedPostRow[] };
        const lines = [ctx.theme.emphasis(`QUEUED POSTS (${d.posts.length})`)];
        for (const post of d.posts) lines.push(postLine(post, ctx));
        if (d.posts.length === 0) lines.push(ctx.theme.meta("  none; a seat queues one with social_schedule, approved at queue time"));
        return lines;
      },
    },
    {
      name: "edit <id>",
      description: "Change a queued post's text, media, account or platform; a change re-asks for approval of exactly the new content",
      options: [
        { flags: "--text <text>", description: "The new post text" },
        { flags: "--media <url>", description: "A publicly hosted https media URL" },
        { flags: "--account <id>", description: "The platform account id the post goes out from" },
        { flags: "--platform <platform>", description: "The platform the post goes to" },
      ],
      async run(ctx, opts, args) {
        const id = String(args[0]);
        if (ctx.dryRun) return dry("cron queue edit", id);
        const patch = { text: optionalString(opts, "text"), mediaUrl: optionalString(opts, "media"), accountId: optionalString(opts, "account"), platform: optionalString(opts, "platform") };
        if (Object.values(patch).every((value) => value === undefined)) {
          throw new TrentError({ code: EXIT.CONFIG, operation: "cron.queue.edit", message: "edit needs at least one of --text, --media, --account, --platform", target: id });
        }
        const result = await editQueuedPost(queueDeps(ctx), id, patch);
        return { data: { id: result.id, changed: result.changed, approval: approvalOf(result.approval) } };
      },
      render(data, ctx) {
        const d = data as { dryRun?: boolean; id: string; changed?: boolean; approval?: { id: string; status: string; preview: string } | null };
        if (d.dryRun === true) return [`  ${ctx.theme.meta("would edit")} ${ctx.theme.value(d.id)}`];
        if (d.changed !== true) return [`  ${ctx.theme.meta("unchanged")} ${ctx.theme.value(d.id)} ${ctx.theme.meta("the approval stands")}`];
        const approval = d.approval ?? null;
        return [
          `  ${ctx.theme.success("edited")} ${ctx.theme.value(d.id)} ${ctx.theme.meta("the previous approval no longer covers it")}`,
          ...(approval === null ? [] : [`  ${ctx.theme.meta("approve exactly this with")} ${ctx.theme.value(`trent approvals approve ${approval.id}`)}`, `    ${ctx.theme.body(approval.preview)}`]),
        ];
      },
    },
    {
      name: "move <id> <when>",
      description: "Move a queued post to another time (ISO 8601 with a zone); the content and its approval are unchanged",
      run(ctx, _opts, args) {
        const id = String(args[0]);
        const when = String(args[1]);
        if (ctx.dryRun) return dry("cron queue move", id, { when });
        const result = moveQueuedPost(queueDeps(ctx), id, when);
        return { data: { id: result.id, at: result.at, enabled: result.enabled, approval: approvalOf(result.approval) } };
      },
      render(data, ctx) {
        const d = data as { dryRun?: boolean; id: string; when?: string; at?: string; approval?: { status: string } | null };
        if (d.dryRun === true) return [`  ${ctx.theme.meta("would move")} ${ctx.theme.value(d.id)} ${ctx.theme.meta(`to ${String(d.when)}`)}`];
        return [`  ${ctx.theme.success("moved")} ${ctx.theme.value(d.id)} ${ctx.theme.meta(`to ${String(d.at)}; approval ${d.approval?.status ?? "none"}`)}`];
      },
    },
    {
      name: "rm <id>",
      description: "Remove a queued post and its pending approval row",
      run(ctx, _opts, args) {
        const id = String(args[0]);
        if (ctx.dryRun) return dry("cron queue rm", id);
        const result = removeQueuedPost(queueDeps(ctx), id);
        return { data: { id: result.id, approval: result.approval, count: result.count } };
      },
      render(data, ctx) {
        const d = data as { dryRun?: boolean; id: string; approval?: string };
        if (d.dryRun === true) return [`  ${ctx.theme.meta("would remove")} ${ctx.theme.value(d.id)}`];
        return [`  ${ctx.theme.success("removed")} ${ctx.theme.value(d.id)} ${ctx.theme.meta(`approval row ${String(d.approval)}`)}`];
      },
    },
  ],
};
