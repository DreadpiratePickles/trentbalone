/**
 * E1 — the store a caller uses: record a write, list the turns, undo the ones after a turn.
 *
 * `record` runs BEFORE the write lands, which is the whole point: the pre-image has to be durable
 * before the only copy of it is overwritten. An identical write records nothing, so the turn list
 * never claims a file was touched when its bytes did not change.
 *
 * `rollback` refuses as a whole rather than in part. A partial restore leaves a workspace that is
 * neither the state the agent produced nor the state before it, which is the one outcome nobody
 * can reason about; so a file a human edited since the agent wrote it stops the operation and
 * names itself, and `--force` is the explicit way past that.
 */

import fs from "node:fs";
import path from "node:path";
import { CheckpointLedger, sha256 } from "./ledger.js";
import { checkpointsOf, rollbackPlan, type RollbackItem } from "./plan.js";
import {
  DEFAULT_MAX_BYTES_PER_RUN,
  type Checkpoint,
  type CheckpointStoreOptions,
  type LedgerEntry,
  type RecordInput,
  type RefusedPath,
  type RestoredPath,
  type RollbackResult,
} from "./types.js";

export interface RollbackInput {
  readonly runId: string;
  /** The turn whose writes are kept; everything after it is undone. */
  readonly to: number;
  readonly force?: boolean;
  /** Attribution for the rows the rollback itself writes. */
  readonly turn?: number;
  readonly seat?: string;
}

export class CheckpointStore {
  readonly enabled: boolean;
  private readonly ledger: CheckpointLedger;
  private readonly maxBytesPerRun: number;

  constructor(options: CheckpointStoreOptions) {
    this.enabled = options.enabled !== false;
    this.maxBytesPerRun = options.maxBytesPerRun ?? DEFAULT_MAX_BYTES_PER_RUN;
    this.ledger = new CheckpointLedger(options.workspace, options.profileDir);
  }

  runDir(runId: string): string {
    return this.ledger.runDir(runId);
  }

  preImagePath(ref: string): string {
    return this.ledger.preImagePath(ref);
  }

  entries(runId: string): LedgerEntry[] {
    return this.enabled ? this.ledger.entries(runId) : [];
  }

  listRuns(): string[] {
    return this.enabled ? this.ledger.runs() : [];
  }

  listCheckpoints(runId: string): Checkpoint[] {
    return checkpointsOf(this.entries(runId));
  }

  /** Ledgers one write. Returns the row, or undefined when there is nothing to undo. */
  record(input: RecordInput): LedgerEntry | undefined {
    if (!this.enabled) return undefined;
    const relative = this.ledger.relativize(input.path);
    this.ledger.runDir(input.runId);
    const beforeHash = input.before === undefined ? null : sha256(input.before);
    const afterHash = input.after === undefined ? null : sha256(input.after);
    if (beforeHash === afterHash) return undefined;

    let ref: string | null = null;
    let note: string | undefined;
    if (input.before !== undefined && beforeHash !== null) {
      const stored = this.ledger.storedBytes(input.runId);
      if (stored + input.before.length > this.maxBytesPerRun) {
        note = `pre-image not stored: this run is at ${stored} of checkpoints.max_bytes_per_run (${this.maxBytesPerRun}); the row keeps hashes only and this path cannot be rolled back`;
      } else {
        ref = this.ledger.putPreImage(input.runId, beforeHash, input.before);
      }
    }
    const entry: LedgerEntry = {
      run_id: input.runId,
      turn: input.turn,
      step: input.step,
      seat: input.seat,
      tool: input.tool,
      path: relative,
      before_hash: beforeHash,
      before_bytes_ref: ref,
      after_hash: afterHash,
      at: input.at ?? new Date().toISOString(),
      ...(note === undefined ? {} : { note }),
    };
    this.ledger.append(entry);
    return entry;
  }

  /** Undoes every write after turn `to`, newest-touched path first, or refuses and touches nothing. */
  rollback(input: RollbackInput): RollbackResult {
    const force = input.force === true;
    const base = { runId: input.runId, to: input.to, forced: force };
    if (!this.enabled) {
      return { ...base, ok: false, restored: [], refused: [{ path: "", reason: "checkpoints.enabled is false for this profile" }] };
    }
    const rows = this.entries(input.runId);
    if (rows.length === 0) {
      return { ...base, ok: false, restored: [], refused: [{ path: "", reason: `no ledger for run ${input.runId}` }] };
    }
    const plan = rollbackPlan(rows, input.to);
    const refused: RefusedPath[] = [];
    for (const item of plan) {
      const reason = this.refusalFor(item, force);
      if (reason !== undefined) refused.push({ path: item.path, reason });
    }
    if (refused.length > 0) return { ...base, ok: false, restored: [], refused };

    const restored: RestoredPath[] = [];
    const turn = input.turn ?? Math.max(...rows.map((row) => row.turn)) + 1;
    let step = 0;
    for (const item of plan) {
      const host = this.ledger.hostPath(item.path);
      const disk = fs.existsSync(host) ? fs.readFileSync(host) : undefined;
      const target = item.targetRef === null ? undefined : this.ledger.readPreImage(item.targetRef);
      if (item.targetHash === null) removeFile(host);
      else if (target !== undefined) writeFileExact(host, target);
      step += 1;
      this.record({
        runId: input.runId,
        turn,
        step,
        seat: input.seat ?? "human",
        tool: "rollback",
        path: item.path,
        before: disk,
        after: target,
      });
      restored.push({ path: item.path, hash: item.targetHash });
    }
    return { ...base, ok: true, restored, refused: [] };
  }

  /** Why this path cannot be restored, or undefined when it can. */
  private refusalFor(item: RollbackItem, force: boolean): string | undefined {
    if (item.targetHash !== null && item.targetRef === null) {
      return "its pre-image was never stored (the run was over checkpoints.max_bytes_per_run), so it cannot be restored byte-exact";
    }
    if (item.targetRef !== null && this.ledger.readPreImage(item.targetRef) === undefined) {
      return "its pre-image is missing from the profile's checkpoint store";
    }
    if (force) return undefined;
    const host = this.ledger.hostPath(item.path);
    const disk = fs.existsSync(host) ? sha256(fs.readFileSync(host)) : null;
    if (disk === item.expectedHash || disk === item.targetHash) return undefined;
    return "it changed on disk since the agent wrote it; re-run with force to overwrite that edit";
  }
}

/** Write-then-rename, keeping the file's existing mode; a crash leaves the old bytes, not half. */
function writeFileExact(target: string, bytes: Buffer): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const mode = fs.existsSync(target) ? fs.statSync(target).mode & 0o777 : undefined;
  const tmp = `${target}.${process.pid}.trent-rollback`;
  fs.writeFileSync(tmp, bytes, mode === undefined ? {} : { mode });
  fs.renameSync(tmp, target);
  if (mode !== undefined) fs.chmodSync(target, mode);
}

function removeFile(target: string): void {
  if (fs.existsSync(target)) fs.rmSync(target, { force: true });
}
