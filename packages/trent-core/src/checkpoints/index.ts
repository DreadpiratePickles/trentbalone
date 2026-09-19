/**
 * E1 — checkpoints and rollback (docs/checkpoints.md).
 *
 * `CheckpointStore` is the whole surface a command needs: record a write, list a run's turns,
 * undo the ones after a chosen turn. `CheckpointSession` adds the turn boundary and the ambient
 * lookup `file_ops` uses. `trent checkpoints list|rollback` is built on these two and needs
 * nothing else from this module.
 */

export { CheckpointLedger, sha256 } from "./ledger.js";
export { checkpointsOf, rollbackPlan, type RollbackItem } from "./plan.js";
export { CheckpointStore, type RollbackInput } from "./store.js";
export {
  CheckpointSession,
  activeCheckpointSession,
  closeCheckpointSession,
  openCheckpointSession,
  type CheckpointSessionOptions,
  type SessionRecordInput,
} from "./session.js";
export {
  CheckpointPathError,
  DEFAULT_MAX_BYTES_PER_RUN,
  LEDGER_DIR_MODE,
  LEDGER_FILE_MODE,
  type Checkpoint,
  type CheckpointStoreOptions,
  type LedgerEntry,
  type RecordInput,
  type RefusedPath,
  type RestoredPath,
  type RollbackResult,
} from "./types.js";
