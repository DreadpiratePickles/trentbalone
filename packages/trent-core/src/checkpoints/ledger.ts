/**
 * E1 — the on-disk half of the ledger: where a row goes, where a pre-image goes, and the two
 * confinements that make either safe.
 *
 *   `<profileDir>/checkpoints/`                     0700
 *   `<profileDir>/checkpoints/<run_id>/ledger.jsonl` 0600, append-only, one JSON row per line
 *   `<profileDir>/checkpoints/<run_id>/blobs/<hh>/<sha256>` 0600, content-addressed pre-images
 *
 * A pre-image never leaves the profile directory and a recorded path never leaves the workspace:
 * both are checked here rather than at the call site, because the call site is a tool the model
 * drives. A blob is written temp-then-rename, so a crash leaves either nothing or the whole
 * pre-image — never a truncated one that a rollback would restore as if it were the file.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CheckpointPathError, LEDGER_DIR_MODE, LEDGER_FILE_MODE, type LedgerEntry } from "./types.js";

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function mkdir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: LEDGER_DIR_MODE });
  try {
    fs.chmodSync(dir, LEDGER_DIR_MODE);
  } catch {
    // A mount that refuses chmod still has to be usable; the containment check above is the wall.
  }
}

/** realpath of `target`, or of its nearest existing ancestor with the missing tail re-joined. */
function realpathLenient(target: string): string {
  const missing: string[] = [];
  let probe = target;
  for (;;) {
    try {
      return path.join(fs.realpathSync(probe), ...missing.reverse());
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return target;
      missing.push(path.basename(probe));
      probe = parent;
    }
  }
}

/** The ledger's filesystem: paths, modes, appends and the content-addressed pre-image store. */
export class CheckpointLedger {
  readonly root: string;
  private readonly workspaceRoots: readonly string[];
  private readonly bytesByRun = new Map<string, number>();

  constructor(
    private readonly workspace: string,
    profileDir: string,
  ) {
    this.root = path.join(profileDir, "checkpoints");
    const real = realpathLenient(workspace);
    this.workspaceRoots = real === workspace ? [workspace] : [workspace, real];
  }

  runDir(runId: string): string {
    if (!RUN_ID.test(runId) || runId.includes("..")) {
      throw new CheckpointPathError(`run id ${JSON.stringify(runId)} is not a safe directory name`);
    }
    return path.join(this.root, runId);
  }

  /** Workspace-relative POSIX path, or a refusal. Absolute inputs must already be inside. */
  relativize(input: string): string {
    if (input === "" || input.includes("\0")) throw new CheckpointPathError("path is empty or contains NUL");
    const absolute = path.isAbsolute(input) ? input : path.resolve(this.workspace, input);
    for (const candidate of [absolute, realpathLenient(absolute)]) {
      for (const root of this.workspaceRoots) {
        const relative = path.relative(root, candidate);
        if (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)) {
          return relative.split(path.sep).join("/");
        }
      }
    }
    throw new CheckpointPathError(`${input} resolves outside the workspace; it is not ledgerable`);
  }

  /** Absolute host path of a workspace-relative path the ledger stored. */
  hostPath(relative: string): string {
    return path.join(this.workspace, this.relativize(relative));
  }

  /** Absolute host path of a `before_bytes_ref`, refused if it would leave the checkpoint root. */
  preImagePath(ref: string): string {
    const resolved = path.resolve(this.root, ref);
    if (resolved !== this.root && !resolved.startsWith(`${this.root}${path.sep}`)) {
      throw new CheckpointPathError(`pre-image reference ${ref} points outside the profile`);
    }
    return resolved;
  }

  /** Bytes of pre-image already stored for this run, counted once per store instance. */
  storedBytes(runId: string): number {
    const cached = this.bytesByRun.get(runId);
    if (cached !== undefined) return cached;
    let total = 0;
    const blobs = path.join(this.runDir(runId), "blobs");
    for (const entry of fs.existsSync(blobs) ? fs.readdirSync(blobs, { withFileTypes: true }) : []) {
      if (!entry.isDirectory()) continue;
      const shard = path.join(blobs, entry.name);
      for (const file of fs.readdirSync(shard)) total += fs.statSync(path.join(shard, file)).size;
    }
    this.bytesByRun.set(runId, total);
    return total;
  }

  /** Stores the pre-image and returns its ref, or undefined when it is already stored. */
  putPreImage(runId: string, hash: string, bytes: Buffer): string {
    const ref = `${runId}/blobs/${hash.slice(0, 2)}/${hash}`;
    const target = this.preImagePath(ref);
    if (fs.existsSync(target)) return ref;
    mkdir(path.dirname(target));
    const tmp = `${target}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, bytes, { mode: LEDGER_FILE_MODE });
      fs.chmodSync(tmp, LEDGER_FILE_MODE);
      fs.renameSync(tmp, target);
    } catch (error) {
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch {
        // Best effort: the target is either absent or complete either way.
      }
      throw error;
    }
    this.bytesByRun.set(runId, this.storedBytes(runId) + bytes.length);
    return ref;
  }

  readPreImage(ref: string): Buffer | undefined {
    const file = this.preImagePath(ref);
    return fs.existsSync(file) ? fs.readFileSync(file) : undefined;
  }

  ledgerFile(runId: string): string {
    return path.join(this.runDir(runId), "ledger.jsonl");
  }

  /** One row, one append. O_APPEND makes a single write of a single line atomic against readers. */
  append(entry: LedgerEntry): void {
    const dir = this.runDir(entry.run_id);
    mkdir(dir);
    const file = this.ledgerFile(entry.run_id);
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: LEDGER_FILE_MODE });
    try {
      fs.chmodSync(file, LEDGER_FILE_MODE);
    } catch {
      // As for directories: a filesystem that refuses chmod degrades rather than failing the write.
    }
  }

  /** Every row of a run, oldest first. A half-written last line is dropped, never guessed at. */
  entries(runId: string): LedgerEntry[] {
    const file = this.ledgerFile(runId);
    if (!fs.existsSync(file)) return [];
    const rows: LedgerEntry[] = [];
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        rows.push(JSON.parse(line) as LedgerEntry);
      } catch {
        continue;
      }
    }
    return rows;
  }

  /** Run ids this profile has a ledger for, newest ledger first. */
  runs(): string[] {
    if (!fs.existsSync(this.root)) return [];
    return fs
      .readdirSync(this.root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(this.root, entry.name, "ledger.jsonl")))
      .map((entry) => ({ id: entry.name, at: fs.statSync(path.join(this.root, entry.name, "ledger.jsonl")).mtimeMs }))
      .sort((a, b) => b.at - a.at)
      .map((entry) => entry.id);
  }
}
