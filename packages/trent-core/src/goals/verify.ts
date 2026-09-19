/**
 * D4 — verify_on_stop: a turn that edited code cannot give a final answer on its own word.
 *
 * The rule is one sentence: if the checkpoint ledger says this turn wrote files, the turn does not
 * end with an answer unless a verification command exited 0 AFTER the last of those writes. A green
 * run from before the last write proves something about bytes that no longer exist, so it does not
 * count — that ordering is the entire difference between this and a checkbox.
 *
 * The writes come from the ledger E1 already keeps (`checkpoints/`), not from a second record: the
 * one place that knows what the agent landed is the place that ledgered it before it landed. The
 * rows are read structurally so this module does not import the ledger.
 */

import { matchesVerification, type VerificationEvent } from "./evidence.js";
import { DEFAULT_VERIFY_COMMANDS } from "./types.js";

/** One row of the checkpoint ledger, as this module reads it. `LedgerEntry` satisfies it. */
export interface LedgerRow {
  readonly turn: number;
  readonly path: string;
  readonly at: string;
  readonly tool: string;
}

/** One write, with its time as a number so it can be compared to the evidence ledger's clock. */
export interface TurnWrite {
  readonly path: string;
  readonly at: number;
}

/**
 * The files this turn wrote, first touch first. A `rollback` row is not an agent write — it is the
 * undo of one — so a turn that only rolled back is a turn that edited nothing.
 */
export function turnWrites(rows: readonly LedgerRow[], turn: number): TurnWrite[] {
  const writes: TurnWrite[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.turn !== turn || row.tool === "rollback" || seen.has(row.path)) continue;
    const at = Date.parse(row.at);
    seen.add(row.path);
    writes.push({ path: row.path, at: Number.isNaN(at) ? 0 : at });
  }
  return writes;
}

export interface VerifyOnStopInput {
  /** `goals.verify_on_stop`. False makes this inert, which is the profile's decision to make. */
  readonly enabled: boolean;
  readonly writes: readonly TurnWrite[];
  readonly evidence: readonly VerificationEvent[];
  readonly commands?: readonly string[];
  /**
   * When this run's goal gates all exited 0, the moment they did. A green gate is verification by
   * construction — it is the profile's own definition of what must pass — so it counts whatever
   * its argv is and without having to appear in `verify_commands`.
   */
  readonly gatePassedAt?: number;
}

export interface UnverifiedRefusal {
  readonly files: readonly string[];
  /** Plain English: what was edited, and what would settle it. No jargon, no codes. */
  readonly reason: string;
}

const MAX_NAMED_FILES = 5;

/**
 * The refusal for this turn, or nothing when the turn may answer.
 *
 * @returns what was edited and what to run, or `undefined` when the turn is clear.
 */
export function verifyOnStop(input: VerifyOnStopInput): UnverifiedRefusal | undefined {
  if (!input.enabled || input.writes.length === 0) return undefined;
  const commands = input.commands === undefined || input.commands.length === 0 ? DEFAULT_VERIFY_COMMANDS : input.commands;
  const lastWrite = Math.max(...input.writes.map((write) => write.at));
  if (input.gatePassedAt !== undefined && input.gatePassedAt >= lastWrite) return undefined;
  const proof = input.evidence.find(
    (event) => event.exitCode === 0 && event.at >= lastWrite && matchesVerification(event.command, commands),
  );
  if (proof !== undefined) return undefined;

  const files = input.writes.map((write) => write.path);
  const named = files.slice(0, MAX_NAMED_FILES).join(", ");
  const rest = files.length > MAX_NAMED_FILES ? ` and ${files.length - MAX_NAMED_FILES} more` : "";
  return {
    files,
    reason:
      `This turn edited ${named}${rest} and nothing verified the result afterwards, so the answer is not final. ` +
      `Run one of ${commands.join(", ")} and let it exit 0, then ask again. ` +
      `Set goals.verify_on_stop to false in config.yaml to turn this off for the profile.`,
  };
}
