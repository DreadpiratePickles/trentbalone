/**
 * E1 — the shapes the checkpoint ledger writes and reads.
 *
 * One row per write the agent LANDS, written before the write reaches the file. `run_id` names
 * the checkpoint session (one REPL session, or one `trent run`), `turn` the turn inside it, and
 * a checkpoint is simply the ledger position where a turn begins — there is no second index to
 * fall out of step with the rows.
 */

/** A path that would leave the workspace, or a run id that would leave the profile. */
export class CheckpointPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckpointPathError";
  }
}

/** One agent write, as the ledger stores it. Field names are the wire format: snake_case, stable. */
export interface LedgerEntry {
  readonly run_id: string;
  readonly turn: number;
  readonly step: number;
  readonly seat: string;
  /** The tool that wrote: `write_file`, `patch`, `delete_file`, or `rollback` for a restore. */
  readonly tool: string;
  /** POSIX path relative to the workspace root. Never absolute, never traversing. */
  readonly path: string;
  /** sha256 of the bytes before the write; null when the file did not exist. */
  readonly before_hash: string | null;
  /** Where the pre-image bytes live under `<profileDir>/checkpoints/`; null when there are none. */
  readonly before_bytes_ref: string | null;
  /** sha256 of the bytes after the write; null when the write deleted the file. */
  readonly after_hash: string | null;
  readonly at: string;
  /** Why this row carries no pre-image, when it carries none for a file that existed. */
  readonly note?: string;
}

/** The ledger position where one turn begins, and what that turn went on to touch. */
export interface Checkpoint {
  readonly turn: number;
  /** Index into the run's ledger of the first row of this turn. */
  readonly position: number;
  readonly at: string;
  /** Workspace-relative paths this turn wrote, first touch first. */
  readonly files: readonly string[];
  readonly entries: number;
}

export interface RestoredPath {
  readonly path: string;
  /** sha256 of the restored bytes; null when the rollback deleted a file the agent created. */
  readonly hash: string | null;
}

export interface RefusedPath {
  readonly path: string;
  readonly reason: string;
}

export interface RollbackResult {
  readonly runId: string;
  /** The turn whose writes are KEPT. Everything after it is undone. */
  readonly to: number;
  readonly ok: boolean;
  readonly forced: boolean;
  readonly restored: readonly RestoredPath[];
  readonly refused: readonly RefusedPath[];
}

export interface CheckpointStoreOptions {
  /** Absolute host path of the workspace the ledger records paths relative to. */
  readonly workspace: string;
  /** Absolute host path of the profile; every pre-image lives under `<profileDir>/checkpoints/`. */
  readonly profileDir: string;
  /** `checkpoints.enabled`. False records nothing and creates no directory. */
  readonly enabled?: boolean;
  /** `checkpoints.max_bytes_per_run`. Past it a row carries hashes only and says so. */
  readonly maxBytesPerRun?: number;
}

/** What a caller hands the ledger for one write. Bytes, not text: pre-images must be byte-exact. */
export interface RecordInput {
  readonly runId: string;
  readonly turn: number;
  readonly step: number;
  readonly seat: string;
  readonly tool: string;
  /** Absolute host path under the workspace, or a workspace-relative path. */
  readonly path: string;
  /** The bytes on disk before the write; undefined when the file did not exist. */
  readonly before: Buffer | undefined;
  /** The bytes the write lands; undefined when the write deletes the file. */
  readonly after: Buffer | undefined;
  readonly at?: string;
}

/** 50 MB of pre-images per run: past it the ledger keeps hashes and stops storing bytes. */
export const DEFAULT_MAX_BYTES_PER_RUN = 50 * 1024 * 1024;

export const LEDGER_FILE_MODE = 0o600;
export const LEDGER_DIR_MODE = 0o700;
