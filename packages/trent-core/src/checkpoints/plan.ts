/**
 * E1 — the pure half: turns read off the ledger, and what undoing them means per path.
 *
 * Undoing a range of rows is not "replay them backwards one by one". For one path the only two
 * facts that matter are the state the LAST row left on disk (what must still be there, or a human
 * has edited it since) and the pre-image the FIRST row captured (what the path goes back to).
 * Collapsing to those two makes a second rollback to the same turn a no-op instead of a
 * re-application of the rows the first one wrote.
 */

import type { Checkpoint, LedgerEntry } from "./types.js";

/** One checkpoint per turn that wrote anything, in turn order. */
export function checkpointsOf(entries: readonly LedgerEntry[]): Checkpoint[] {
  const byTurn = new Map<number, { position: number; at: string; files: string[]; entries: number }>();
  entries.forEach((entry, index) => {
    const existing = byTurn.get(entry.turn);
    if (existing === undefined) {
      byTurn.set(entry.turn, { position: index, at: entry.at, files: [entry.path], entries: 1 });
      return;
    }
    existing.entries += 1;
    if (!existing.files.includes(entry.path)) existing.files.push(entry.path);
  });
  return [...byTurn.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([turn, value]) => ({ turn, position: value.position, at: value.at, files: [...value.files], entries: value.entries }));
}

/** What one path must look like now, and what it goes back to. */
export interface RollbackItem {
  readonly path: string;
  /** sha256 the last recorded write left on disk; null when that write deleted the file. */
  readonly expectedHash: string | null;
  /** sha256 to restore; null when the path did not exist before the undone range. */
  readonly targetHash: string | null;
  /** Where the bytes are; null when the target is a deletion, or when no pre-image was stored. */
  readonly targetRef: string | null;
  /** Index of the newest row touching this path, so restores run newest-touched first. */
  readonly lastIndex: number;
}

/**
 * The paths written after turn `to`, each collapsed to one restore. `to` is the turn whose own
 * writes are KEPT: `to = 0` undoes the whole run, `to = 1` keeps turn 1 and undoes the rest.
 */
export function rollbackPlan(entries: readonly LedgerEntry[], to: number): RollbackItem[] {
  const first = new Map<string, LedgerEntry>();
  const last = new Map<string, { entry: LedgerEntry; index: number }>();
  entries.forEach((entry, index) => {
    if (entry.turn <= to) return;
    if (!first.has(entry.path)) first.set(entry.path, entry);
    last.set(entry.path, { entry, index });
  });
  return [...first.entries()]
    .map(([file, entry]) => ({
      path: file,
      expectedHash: last.get(file)?.entry.after_hash ?? null,
      targetHash: entry.before_hash,
      targetRef: entry.before_bytes_ref,
      lastIndex: last.get(file)?.index ?? 0,
    }))
    .sort((a, b) => b.lastIndex - a.lastIndex);
}
