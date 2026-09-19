/**
 * [C5 -> W3.1] `/approvals` and held memory writes.
 *
 * A seat that wrote to shared memory on the strength of a web page, a browser read, an MCP server
 * or a delegated child that used one does not get the write: `governance/provenance.ts` parks it
 * as a durable approval row instead (docs/security.md, "Provenance and untrusted context"). C5
 * built that hold and the `approveHeldMemoryWrite` that releases it, and left both unreachable —
 * no surface listed a held write and none could decide one.
 *
 * This is the REPL's half of the fix; `commands/groups/approvals.ts` is the scriptable half. The
 * profile and the UNWRAPPED memory adapter come from the process's held-write session, the way
 * `/checkpoints` takes the open ledger from `activeCheckpointSession()`: a surface must not build
 * its own adapter over a guessed profile, and must not replay through the provenance gate that
 * held the write, which would simply hold it again.
 */

import {
  activeHeldWriteSession,
  approveHeldMemoryWrite,
  denyHeldMemoryWrite,
  listHeldMemoryWrites,
  summariseHeldWrite,
  type HeldWriteSummary,
} from "@trent/core/tools/index.js";
import { GLYPHS, type Theme } from "../ui/index.js";

export type { HeldWriteSummary } from "@trent/core/tools/index.js";

/** The writes this session has parked, or none at all when no session registered a memory adapter. */
export function heldWrites(): HeldWriteSummary[] {
  const session = activeHeldWriteSession();
  if (session === undefined) return [];
  return listHeldMemoryWrites(session.profileDir).map(summariseHeldWrite);
}

/** One entry per held write: what kind of write, which seat, and the untrusted tools it came from. */
export function heldWriteLines(rows: readonly HeldWriteSummary[], theme: Theme): string[] {
  if (rows.length === 0) return [];
  const lines = [`  ${theme.meta(`held memory writes (${rows.length})`)}`];
  for (const row of rows) {
    lines.push(`  ${theme.needsApproval(GLYPHS.needsApproval)} ${theme.emphasis(row.id)} ${theme.body(`${row.kind} write by ${row.seat}`)}`);
    lines.push(`    ${theme.meta(`${row.tool} derived from ${row.tools.join(", ")}`)}`);
  }
  return lines;
}

/** Approving replays the seat's own action with the provenance recorded; rejecting discards it. */
export async function decideHeldWrite(theme: Theme, id: string, sub: "approve" | "reject"): Promise<string> {
  const session = activeHeldWriteSession();
  if (session === undefined) return `  ${theme.body(`This session cannot decide ${id}: it has no memory adapter open.`)}`;
  if (sub === "reject") {
    const denied = denyHeldMemoryWrite({ profileDir: session.profileDir, id });
    return denied.ok
      ? `  ${theme.body(`Held write ${id} discarded; nothing was written.`)}`
      : `  ${theme.body(`Held write ${id} could not be discarded: ${denied.reason.replace(/_/g, " ")}.`)}`;
  }
  const approved = await approveHeldMemoryWrite({ profileDir: session.profileDir, id, memory: session.memory });
  return approved.ok
    ? `  ${theme.body(`Held write ${id} ${approved.record.status}, tagged provenance ${approved.provenance}.`)}`
    : `  ${theme.body(`Held write ${id} could not be approved: ${approved.reason.replace(/_/g, " ")}.`)}`;
}
