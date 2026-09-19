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
 */

import { EXIT, TrentError } from "@trent/core/errors/index.js";
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
}

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
    .map((row) => ({ id: row.id, agentId: row.agentId, action: row.action, createdAt: row.createdAt, runId: row.runId ?? null }));
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
): Promise<{ id: string; status: string; held: boolean; provenance?: string; action?: string }> {
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

export const approvalsSpec: CommandSpec = {
  name: "approvals",
  description: "List and decide what is waiting on a human: run approvals and held memory writes",
  subcommands: [
    {
      name: "list",
      description: "Every pending run approval and every memory write held for its untrusted provenance",
      run(ctx) {
        if (ctx.dryRun) return dry("approvals list");
        return { data: { pending: pendingApprovals(ctx), held: heldWrites(ctx) } };
      },
      render(data, ctx) {
        const d = data as { dryRun?: boolean; pending: PendingApproval[]; held: HeldWriteSummary[] };
        if (d.dryRun === true) return [`  ${ctx.theme.meta("would list")} the pending approvals and the held memory writes`];
        const lines = [ctx.theme.emphasis(`APPROVALS (${d.pending.length}) ${d.held.length} held memory writes`)];
        for (const row of d.pending) {
          lines.push(`  ${ctx.theme.value(row.id)} ${ctx.theme.body(row.action)} ${ctx.theme.meta(row.agentId)}`);
        }
        if (d.held.length > 0) {
          lines.push(ctx.theme.emphasis(`HELD WRITES (${d.held.length}) derived from untrusted tools`));
          lines.push(...d.held.map((row) => renderHeld(row, ctx)));
        }
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
        const d = data as { dryRun?: boolean; id: string; status?: string; held?: boolean; provenance?: string };
        if (d.dryRun === true) return [`  ${ctx.theme.meta("would approve")} ${ctx.theme.value(d.id)}`];
        const tail = d.held === true ? ctx.theme.meta(`held memory write, written with provenance ${String(d.provenance)}`) : ctx.theme.meta("run approval");
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
        const d = data as { dryRun?: boolean; id: string; status?: string; held?: boolean };
        if (d.dryRun === true) return [`  ${ctx.theme.meta("would reject")} ${ctx.theme.value(d.id)}`];
        const tail = d.held === true ? ctx.theme.meta("held memory write discarded; nothing was written") : ctx.theme.meta("run approval");
        return [`  ${ctx.theme.needsApproval(String(d.status))} ${ctx.theme.value(d.id)} ${tail}`];
      },
    },
  ],
};
