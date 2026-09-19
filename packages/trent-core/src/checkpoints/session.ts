/**
 * E1 — the turn boundary, and how a tool five call frames down finds it.
 *
 * `file_ops` is handed a `ToolContext` (a workspace and a profile) and nothing about the session
 * it runs inside, so the run id, the turn and the seat reach it through a process-level session
 * opened by whoever owns the turn boundary: the REPL opens one per session and calls `beginTurn`
 * per turn, and `trent run` opens one whose single turn is the run. With no session open the
 * adapter records nothing, which is exactly what checkpoints being off should mean.
 *
 * One session at a time, deliberately: the ledger's ordering is what rollback replays, and two
 * concurrent sessions writing one profile's ledger would interleave turns that never coexisted.
 * Seats inside a session are sequential; `setSeat` attributes their rows.
 */

import { CheckpointStore, type RollbackInput } from "./store.js";
import type { Checkpoint, CheckpointStoreOptions, LedgerEntry, RollbackResult } from "./types.js";

export interface CheckpointSessionOptions extends CheckpointStoreOptions {
  /** Identifies this session's ledger: one REPL session, or one `trent run`. */
  readonly runId: string;
  /** Attribution for rows until `setSeat` says otherwise. */
  readonly seat?: string;
}

/** What a tool hands the session: the rest of the row is the session's to fill in. */
export interface SessionRecordInput {
  readonly tool: string;
  readonly path: string;
  readonly before: Buffer | undefined;
  readonly after: Buffer | undefined;
}

export class CheckpointSession {
  readonly store: CheckpointStore;
  readonly runId: string;
  #turn = 0;
  #step = 0;
  #wrote = false;
  #seat: string;

  constructor(options: CheckpointSessionOptions) {
    this.store = new CheckpointStore(options);
    this.runId = options.runId;
    this.#seat = options.seat ?? "agent";
  }

  get turn(): number {
    return this.#turn;
  }

  get seat(): string {
    return this.#seat;
  }

  /**
   * Opens the next turn: every write from here belongs to the checkpoint it starts. Opening a
   * turn that nobody has written into yet returns that same turn, so the runtime opening one per
   * run and a surface opening one per turn cannot between them leave a gap in the numbers a
   * human types into `/rollback`.
   */
  beginTurn(seat?: string): number {
    if (seat !== undefined) this.#seat = seat;
    if (this.#turn > 0 && !this.#wrote) return this.#turn;
    this.#turn += 1;
    this.#step = 0;
    this.#wrote = false;
    return this.#turn;
  }

  setSeat(seat: string): void {
    this.#seat = seat;
  }

  /** Ledgers one write in the current turn. A `trent run` that never called `beginTurn` is turn 1. */
  record(input: SessionRecordInput): LedgerEntry | undefined {
    if (this.#turn === 0) this.beginTurn();
    this.#step += 1;
    const entry = this.store.record({
      runId: this.runId,
      turn: this.#turn,
      step: this.#step,
      seat: this.#seat,
      tool: input.tool,
      path: input.path,
      before: input.before,
      after: input.after,
    });
    // A turn whose writes all changed nothing has no rows, so it is no checkpoint and no turn.
    if (entry !== undefined) this.#wrote = true;
    return entry;
  }

  listCheckpoints(): Checkpoint[] {
    return this.store.listCheckpoints(this.runId);
  }

  rollback(input: Omit<RollbackInput, "runId"> & { runId?: string }): RollbackResult {
    return this.store.rollback({ ...input, runId: input.runId ?? this.runId, turn: input.turn ?? this.#turn });
  }
}

let active: CheckpointSession | undefined;

/** Opens the process's checkpoint session, replacing any previous one. */
export function openCheckpointSession(options: CheckpointSessionOptions): CheckpointSession {
  active = new CheckpointSession(options);
  return active;
}

export function activeCheckpointSession(): CheckpointSession | undefined {
  return active;
}

/**
 * Closes the session, so a later tool call records nothing rather than into a finished run.
 * With a session given, closes only that one: a runtime whose session has already been replaced
 * must not take the replacement down with it on cleanup.
 */
export function closeCheckpointSession(session?: CheckpointSession): void {
  if (session === undefined || active === session) active = undefined;
}
