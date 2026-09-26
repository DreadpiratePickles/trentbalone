/**
 * The `approvals` group [W3.1]: the scriptable door onto everything that is waiting on a human.
 *
 * Two kinds of row land in this profile's `gateway.json`. A RUN APPROVAL is a step the autonomy
 * level parked; `ApprovalBridge.decide` is its local decision path, the same one the TUI uses. A
 * HELD MEMORY WRITE is C5's: a seat wrote to shared memory on the strength of a web page, a
 * browser read or an MCP server, so the write waits instead of landing, and approving it replays
 * the seat's own action with `[provenance: untrusted via <tools>]` appended to the entry. Until
 * this command existed the second kind could be created and never decided.
 *
 * `list` shows both. `approve`/`reject` take either id and route on which kind it is, so a founder
 * never has to know which file a row lives in. Under `--dry-run` each one answers
 * `{dryRun, command, id}` at exit 0 and reads nothing, the convention afe10b6 fixed `fleet show`
 * to keep.
 *
 * [H1] auto review: flags on the existing commands, no new command. `list --review` runs the auto
 * reviewer (`governance/auto-review.ts`) over the held calls first, inside `governance.auto_review`;
 * `list --policy` prints that written policy; `list` always shows what the reviewer decided, with its
 * actor. `reject` on a call the reviewer approved reverses it while the call has not run, and
 * `approve` on one it denied approves it: a person's decision is the last word.
 */

import { EXIT, TrentError } from "@trent/core/errors/index.js";
// [H1] auto review
import { DEFAULT_AUTO_REVIEW, autoReviewGrantUsedAt, type AutoReviewConfig } from "@trent/core/governance/auto-review-config.js";
import { autoReviewOf, overrideAutoReview, reviewHeldApprovals, type AutoReviewRecord, type ReviewGateway, type ReviewOutcome, type ReviewPass } from "@trent/core/governance/auto-review.js";
import { openSpendLedger } from "@trent/core/governance/spend-ledger.js";
import type { ModelProvider } from "@trent/core/model-gateway/index.js";
import { ApprovalBridge, FileGatewayStore, type ApprovalRow } from "@trent/core/gateway/index.js";
import {
  HELD_WRITE_ACTION,
  approveHeldMemoryWrite,
  denyHeldMemoryWrite,
  listHeldMemoryWrites,
  summariseHeldWrite,
  type HeldWriteSummary,
} from "@trent/core/tools/index.js";
import { createMemoryAdapter } from "@trent/core/tools/memory/index.js";
import os from "node:os";
import path from "node:path";
import type { CommandContext } from "../context.js";
import type { CommandSpec } from "../registry.js";

/** One run approval as this command lists it; the held writes have their own shape. */
interface PendingApproval {
  readonly id: string;
  readonly agentId: string;
  readonly action: string;
  readonly createdAt: string;
  readonly runId: string | null;
  /** [H1] What the auto reviewer said about a row it left for a person (escalated). */
  readonly review?: ReviewView;
}

/** [H1] The reviewer's record as `list` shows it. */
interface ReviewView {
  readonly decision: string;
  readonly actor: string;
  readonly reason: string;
  readonly rule?: string;
}

/** [H1] A row the auto reviewer approved or denied, newest first, with whether its call has run. */
interface ReviewedApproval {
  readonly id: string;
  readonly agentId: string;
  readonly action: string;
  readonly status: string;
  /** Who decided it last: `auto-review:<model>`, or the person who overrode the reviewer. */
  readonly actor: string;
  readonly reviewer: string;
  readonly reason: string;
  readonly decidedAt: string | null;
  readonly ran: boolean;
  readonly ranAt: string | null;
  readonly overriddenBy: string | null;
}

/** How many reviewed rows `list` shows; the audit chain (`approvals-audit.ndjson`) holds every one. */
const REVIEWED_SHOWN = 20;

const dry = (command: string, extra: Record<string, unknown> = {}) => ({ data: { dryRun: true, command, ...extra } });

function profileDirOf(ctx: CommandContext): string {
  return ctx.config().getProfileDir();
}

function gatewayStore(ctx: CommandContext): FileGatewayStore {
  return new FileGatewayStore(path.join(profileDirOf(ctx), "gateway.json"));
}

/** The pending rows that are NOT held writes: a held write is listed and decided separately. */
function pendingApprovals(ctx: CommandContext): PendingApproval[] {
  const rows: ApprovalRow[] = Object.values(gatewayStore(ctx).snapshot().approvals);
  return rows
    .filter((row) => row.status === "pending" && row.action !== HELD_WRITE_ACTION)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((row) => {
      const review = autoReviewOf(row);
      return { id: row.id, agentId: row.agentId, action: row.action, createdAt: row.createdAt, runId: row.runId ?? null, ...(review === undefined ? {} : { review: viewOf(review) }) };
    });
}

function viewOf(record: AutoReviewRecord): ReviewView {
  return { decision: record.decision, actor: record.actor, reason: record.reason, ...(record.rule === undefined ? {} : { rule: record.rule }) };
}

/** [H1] Rows the auto reviewer decided (approve or deny), including any a person has since overridden. */
function reviewedApprovals(ctx: CommandContext): ReviewedApproval[] {
  const rows: ApprovalRow[] = Object.values(gatewayStore(ctx).snapshot().approvals);
  const reviewed: ReviewedApproval[] = [];
  for (const row of rows) {
    const record = autoReviewOf(row);
    if (record === undefined || record.decision === "escalate" || row.status === "pending") continue;
    const ranAt = autoReviewGrantUsedAt(row) ?? null;
    reviewed.push({
      id: row.id,
      agentId: row.agentId,
      action: row.action,
      status: row.status,
      actor: row.decidedBy ?? record.actor,
      reviewer: record.actor,
      reason: record.reason,
      decidedAt: row.decidedAt ?? null,
      ran: ranAt !== null,
      ranAt,
      overriddenBy: record.overriddenBy ?? null,
    });
  }
  return reviewed.sort((a, b) => (b.decidedAt ?? "").localeCompare(a.decidedAt ?? "")).slice(0, REVIEWED_SHOWN);
}

/** [H1] The written policy this profile holds. */
function policyOf(ctx: CommandContext): AutoReviewConfig {
  return ctx.config().loadConfig().governance?.auto_review ?? DEFAULT_AUTO_REVIEW;
}

/**
 * [H1] One reviewer pass. Refused while the policy is off, so `--review` never looks like it did
 * something it did not. The model is built only if a row is inside the policy, from the profile's
 * provider with `governance.auto_review.model` as the pin.
 */
async function runReview(ctx: CommandContext): Promise<ReviewPass> {
  const config = ctx.config().loadConfig();
  const policy = policyOf(ctx);
  if (!policy.enabled) {
    throw new TrentError({
      code: EXIT.CONFIG,
      operation: "approvals.list",
      message: 'auto review is off: set governance.auto_review.enabled to true in config.yaml, with the policy it may approve inside (docs/security.md, "Auto review")',
      target: "--review",
    });
  }
  const profileDir = profileDirOf(ctx);
  return reviewHeldApprovals({
    store: gatewayStore(ctx),
    profileDir,
    policy,
    hardline: { home: os.homedir(), profileDir },
    deny: config.approvals?.deny ?? [],
    gateway: async (): Promise<ReviewGateway> => {
      ctx.config().loadSecrets();
      const { createModelGateway } = await import("@trent/core/model-gateway/index.js");
      return createModelGateway({ preferredProvider: config.provider as ModelProvider, models: { executor: policy.model ?? config.model } });
    },
    spend: openSpendLedger({ profileDir }),
  });
}

function heldWrites(ctx: CommandContext): HeldWriteSummary[] {
  return listHeldMemoryWrites(profileDirOf(ctx)).map(summariseHeldWrite);
}

/** The memory blocks this profile configures, so an approved entry lands where the seat meant it to. */
function memoryFor(ctx: CommandContext): ReturnType<typeof createMemoryAdapter> {
  const profileDir = profileDirOf(ctx);
  const blocks = (ctx.config().loadConfig() as { memory?: { blocks?: Parameters<typeof createMemoryAdapter>[0]["blocks"] } }).memory?.blocks;
  return createMemoryAdapter({ profileDir, ...(blocks === undefined ? {} : { blocks }) });
}

function refuse(operation: string, id: string, message: string): never {
  throw new TrentError({ code: EXIT.CONFIG, operation, message, target: id });
}

/**
 * Decides one id, whichever kind of row it is. A held write is replayed (or discarded) through
 * C5's own path; anything else goes to the bridge's local decision path. An id that answers to
 * neither is a refusal naming the id, never a silent success.
 */
async function decide(
  ctx: CommandContext,
  id: string,
  decision: "approved" | "denied",
): Promise<{ id: string; status: string; held: boolean; provenance?: string; action?: string; reversed?: boolean }> {
  const profileDir = profileDirOf(ctx);
  const operation = `approvals.${decision === "approved" ? "approve" : "reject"}`;
  const held = listHeldMemoryWrites(profileDir).some((row) => row.id === id);
  if (held) {
    if (decision === "denied") {
      const denied = denyHeldMemoryWrite({ profileDir, id });
      if (!denied.ok) refuse(operation, id, `the held write is ${denied.reason.replace(/_/g, " ")}`);
      return { id, status: "denied", held: true };
    }
    const approved = await approveHeldMemoryWrite({ profileDir, id, memory: memoryFor(ctx) });
    if (!approved.ok) refuse(operation, id, `the held write is ${approved.reason.replace(/_/g, " ")}`);
    if (approved.record.status !== "completed") refuse(operation, id, `the replayed write did not land: ${approved.record.summary}`);
    return { id, status: "approved", held: true, provenance: approved.provenance };
  }
  // [H1] A person over the auto reviewer: reverse its approval while the call has not run, or
  // approve what it denied. Anything else takes the ordinary path below.
  const override = overrideAutoReview({ store: gatewayStore(ctx), profileDir, id, decision, by: "human" });
  if (override.ok) return { id, status: override.row.status, held: false, action: override.row.action, reversed: true };
  if (override.reason === "already_ran") {
    refuse(operation, id, `the auto reviewer approved this call and it already ran at ${override.ranAt ?? "an unrecorded time"}; a call that ran cannot be reversed`);
  }
  const bridge = new ApprovalBridge({ store: gatewayStore(ctx) });
  const row = bridge.getApproval(id);
  if (row === undefined) refuse(operation, id, "no held memory write and no approval row answers to this id");
  try {
    const decided = bridge.decide(id, decision, "human");
    return { id, status: decided.status, held: false, action: decided.action };
  } catch (error) {
    refuse(operation, id, error instanceof Error ? error.message : String(error));
  }
}

function renderHeld(row: HeldWriteSummary, ctx: CommandContext): string {
  return (
    `  ${ctx.theme.value(row.id)} ${ctx.theme.emphasis(row.kind.padEnd(8, " "))} ${ctx.theme.body(row.tool.padEnd(14, " "))}` +
    ` ${ctx.theme.meta(row.seat.padEnd(14, " "))} ${ctx.theme.meta(`from ${row.tools.join(", ")}`)}` +
    `${row.runId === null ? "" : ` ${ctx.theme.meta(`run ${row.runId}`)}`}`
  );
}

interface ListData {
  readonly dryRun?: boolean;
  readonly pending: PendingApproval[];
  readonly held: HeldWriteSummary[];
  readonly reviewed: ReviewedApproval[];
  readonly review?: { readonly outcomes: ReviewOutcome[] };
  readonly policy?: AutoReviewConfig;
}

/** [H1] The reviewer's part of `list`: this pass, its decisions with their actors, and the policy. */
function renderReview(d: ListData, ctx: CommandContext): string[] {
  const lines: string[] = [];
  if (d.review !== undefined) {
    const count = (decision: string): number => d.review!.outcomes.filter((o) => o.decision === decision).length;
    lines.push(ctx.theme.emphasis(`REVIEW PASS ${count("approve")} approved, ${count("deny")} denied, ${count("escalate")} left for you`));
  }
  if (d.reviewed.length > 0) {
    lines.push(ctx.theme.emphasis(`AUTO-REVIEWED (${d.reviewed.length})`));
    for (const row of d.reviewed) {
      const state = row.overriddenBy !== null ? `overridden by ${row.overriddenBy}` : row.status === "denied" ? "denied" : row.ran ? `ran at ${String(row.ranAt)}` : `not yet run: trent approvals reject ${row.id} reverses it`;
      lines.push(`  ${ctx.theme.value(row.id)} ${ctx.theme.body(`${row.status} by ${row.reviewer}`)} ${ctx.theme.meta(`${row.reason} [${state}]`)}`);
    }
  }
  if (d.policy !== undefined) {
    const p = d.policy;
    lines.push(
      ctx.theme.emphasis("POLICY") +
        ` ${ctx.theme.body(p.enabled ? "on" : "off")} ${ctx.theme.meta(`max_class ${p.max_class}, max ${p.max_amount_cents} cents ${p.currency}, recipients ${p.recipients.length === 0 ? "none" : p.recipients.join(" ")}, model ${p.model ?? "the profile's"}`)}`,
    );
  }
  return lines;
}

export const approvalsSpec: CommandSpec = {
  name: "approvals",
  description: "List and decide what is waiting on a human: run approvals and held memory writes",
  subcommands: [
    {
      name: "list",
      description: "Every pending run approval and every memory write held for its untrusted provenance, and what the auto reviewer decided",
      options: [
        // [H1] auto review
        { flags: "--review", description: "First let the auto reviewer decide the held calls inside governance.auto_review" },
        { flags: "--policy", description: "Also print the written auto-review policy" },
      ],
      async run(ctx, opts) {
        const review = opts.review === true;
        const policy = opts.policy === true;
        if (ctx.dryRun) return dry("approvals list", { review, policy });
        const pass = review ? await runReview(ctx) : undefined;
        return {
          data: {
            pending: pendingApprovals(ctx),
            held: heldWrites(ctx),
            reviewed: reviewedApprovals(ctx),
            ...(pass === undefined ? {} : { review: { outcomes: [...pass.outcomes] } }),
            ...(policy ? { policy: policyOf(ctx) } : {}),
          },
        };
      },
      render(data, ctx) {
        const d = data as unknown as ListData;
        if (d.dryRun === true) return [`  ${ctx.theme.meta("would list")} the pending approvals and the held memory writes`];
        const lines = [ctx.theme.emphasis(`APPROVALS (${d.pending.length}) ${d.held.length} held memory writes`)];
        for (const row of d.pending) {
          lines.push(`  ${ctx.theme.value(row.id)} ${ctx.theme.body(row.action)} ${ctx.theme.meta(row.agentId)}`);
          if (row.review !== undefined) lines.push(`    ${ctx.theme.needsApproval("escalated")} ${ctx.theme.meta(`by ${row.review.actor}: ${row.review.reason}`)}`);
        }
        if (d.held.length > 0) {
          lines.push(ctx.theme.emphasis(`HELD WRITES (${d.held.length}) derived from untrusted tools`));
          lines.push(...d.held.map((row) => renderHeld(row, ctx)));
        }
        lines.push(...renderReview(d, ctx));
        lines.push(`  ${ctx.theme.meta("decide one with trent approvals approve <id> or trent approvals reject <id>")}`);
        return lines;
      },
    },
    {
      name: "approve <id>",
      description: "Approve a run approval, or replay a held memory write with its provenance recorded",
      async run(ctx, _opts, args) {
        const id = String(args[0]);
        if (ctx.dryRun) return dry("approvals approve", { id });
        return { data: await decide(ctx, id, "approved") };
      },
      render(data, ctx) {
        const d = data as { dryRun?: boolean; id: string; status?: string; held?: boolean; provenance?: string; reversed?: boolean };
        if (d.dryRun === true) return [`  ${ctx.theme.meta("would approve")} ${ctx.theme.value(d.id)}`];
        const tail =
          d.held === true
            ? ctx.theme.meta(`held memory write, written with provenance ${String(d.provenance)}`)
            : ctx.theme.meta(d.reversed === true ? "approved over the auto reviewer's denial; the identical call now runs" : "run approval");
        return [`  ${ctx.theme.success(String(d.status))} ${ctx.theme.value(d.id)} ${tail}`];
      },
    },
    {
      name: "reject <id>",
      description: "Refuse a run approval, or discard a held memory write without writing it",
      async run(ctx, _opts, args) {
        const id = String(args[0]);
        if (ctx.dryRun) return dry("approvals reject", { id });
        return { data: await decide(ctx, id, "denied") };
      },
      render(data, ctx) {
        const d = data as { dryRun?: boolean; id: string; status?: string; held?: boolean; reversed?: boolean };
        if (d.dryRun === true) return [`  ${ctx.theme.meta("would reject")} ${ctx.theme.value(d.id)}`];
        const tail =
          d.held === true
            ? ctx.theme.meta("held memory write discarded; nothing was written")
            : ctx.theme.meta(d.reversed === true ? "the auto reviewer's approval is reversed; the call had not run and now never will" : "run approval");
        return [`  ${ctx.theme.needsApproval(String(d.status))} ${ctx.theme.value(d.id)} ${tail}`];
      },
    },
  ],
};
