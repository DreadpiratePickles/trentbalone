/**
 * The memory files and the rule that governs them: a hard character cap checked on the FINAL
 * state of a batch, so a seat can remove-and-add in one atomic operation. Writes are temp-file
 * then rename, owner-only, and a failed batch leaves the file byte-identical.
 *
 * The files are COMPANY memory: every seat in the fleet reads and writes the same files
 * (see `../../fleet-memory/README.md`). `commitOperations` is the only writer: it takes a lock,
 * re-reads the file, applies the batch against that fresh state and renames the result in, so two
 * seats committing in parallel steps merge by entry and neither loses the other's write.
 *
 * Every function here addresses a file by `MemoryFileRef`: either a configured `MemoryBlock`
 * (`blocks.ts`) or one of the two legacy `MemoryTarget` labels `"memory" | "user"`, which resolve
 * to the default MEMORY.md / USER.md so the consolidation path and older callers keep working.
 */
import fs from "node:fs";
import path from "node:path";
import { NODE_IO, atomicWriteFileSync } from "../../config/atomic-fs.js";
import { DEFAULT_MEMORY_BLOCKS, findBlock, type MemoryBlock } from "./blocks.js";

export type MemoryTarget = "memory" | "user";
/** A configured block, or anything that names its file — a consolidation draft carries only the name. */
export type MemoryFileRef = MemoryTarget | Pick<MemoryBlock, "file">;
export type MemoryAction = "add" | "replace" | "remove";

function defaultBlock(label: MemoryTarget): MemoryBlock {
  const block = findBlock(DEFAULT_MEMORY_BLOCKS, label);
  if (!block) throw new Error(`default memory block "${label}" is missing`);
  return block;
}

/** The two legacy blocks' caps and files, derived from `DEFAULT_MEMORY_BLOCKS` so there is one source. */
export const MEMORY_CAPS: Record<MemoryTarget, number> = { memory: defaultBlock("memory").limit, user: defaultBlock("user").limit };
export const MEMORY_FILES: Record<MemoryTarget, string> = { memory: defaultBlock("memory").file, user: defaultBlock("user").file };
export const ENTRY_SEPARATOR = "\n§\n";
const OWNER_ONLY = 0o600;

export interface MemoryOperation {
  action: MemoryAction;
  content?: string;
  old_text?: string;
}

export type ApplyResult =
  | { ok: true; entries: string[]; rendered: string; remaining: number }
  | { ok: false; reason: string };

/** The file name a target resolves to: the block's own, or the default block for a legacy label. */
export function memoryFileName(target: MemoryFileRef): string {
  return typeof target === "string" ? MEMORY_FILES[target] : target.file;
}

export function memoryPath(profileDir: string, target: MemoryFileRef): string {
  return path.join(profileDir, "memories", memoryFileName(target));
}

export function readEntries(profileDir: string, target: MemoryFileRef): string[] {
  const file = memoryPath(profileDir, target);
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, "utf8");
  if (!raw.trim()) return [];
  return raw.split(ENTRY_SEPARATOR).map((e) => e.trim()).filter(Boolean);
}

export function render(entries: string[]): string {
  return entries.join(ENTRY_SEPARATOR);
}

/** Index of the single entry containing `needle`; -1 for none, -2 for more than one. */
function locate(entries: string[], needle: string): number {
  const hits = entries.map((e, i) => (e.includes(needle) ? i : -1)).filter((i) => i >= 0);
  if (hits.length === 1) return hits[0]!;
  return hits.length === 0 ? -1 : -2;
}

/** Apply every operation to a copy of the entries; the cap is checked once, on the result. */
export function applyOperations(
  entries: readonly string[],
  operations: readonly MemoryOperation[],
  cap: number
): ApplyResult {
  const next = [...entries];
  for (const [i, op] of operations.entries()) {
    const label = `operation ${i + 1} (${op.action})`;
    const content = typeof op.content === "string" ? op.content.trim() : "";
    const oldText = typeof op.old_text === "string" ? op.old_text.trim() : "";
    if (content.includes(ENTRY_SEPARATOR.trim())) {
      return { ok: false, reason: `${label}: content may not contain the entry separator "${ENTRY_SEPARATOR.trim()}"` };
    }
    switch (op.action) {
      case "add": {
        if (!content) return { ok: false, reason: `${label}: "content" is required` };
        next.push(content);
        break;
      }
      case "replace":
      case "remove": {
        if (!oldText) return { ok: false, reason: `${label}: "old_text" is required` };
        if (op.action === "replace" && !content) return { ok: false, reason: `${label}: "content" is required` };
        const idx = locate(next, oldText);
        if (idx === -1) return { ok: false, reason: `${label}: no entry contains "${oldText}"` };
        if (idx === -2) return { ok: false, reason: `${label}: "${oldText}" matches more than one entry; be more specific` };
        if (op.action === "replace") next[idx] = content;
        else next.splice(idx, 1);
        break;
      }
      default:
        return { ok: false, reason: `${label}: unknown action; use add, replace or remove` };
    }
  }
  const rendered = render(next);
  if (rendered.length > cap) {
    const current = render([...entries]).length;
    return {
      ok: false,
      reason:
        `the result would be ${rendered.length} chars, over the ${cap}-char cap by ${rendered.length - cap}. ` +
        `The file is unchanged: ${current} chars used, ${cap - current} chars remaining. ` +
        `Remove or shorten entries in the same batch to make room.`,
    };
  }
  return { ok: true, entries: next, rendered, remaining: cap - rendered.length };
}

/** Write-then-rename, 0600. The previous file survives any failure. */
export function writeEntries(profileDir: string, target: MemoryFileRef, rendered: string): void {
  const file = memoryPath(profileDir, target);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteFileSync(NODE_IO, file, rendered, OWNER_ONLY);
}

/** A lock older than this is a crashed writer's and is broken. Commits take microseconds. */
const STALE_LOCK_MS = 5_000;
const LOCK_WAIT_MS = 2_000;
const LOCK_POLL_MS = 2;

function lockPath(file: string): string {
  return `${file}.lock`;
}

/**
 * Cross-process mutual exclusion on one memory file: `mkdir` is atomic on every platform Node
 * supports, so the directory IS the lock. Synchronous on purpose — the critical section is a
 * read, an in-memory merge and a rename, and holding it across an await would let another step
 * in this process interleave.
 */
function acquireLock(file: string): () => void {
  const dir = lockPath(file);
  const deadline = Date.now() + LOCK_WAIT_MS;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      fs.mkdirSync(dir);
      return () => {
        try {
          fs.rmdirSync(dir);
        } catch {
          // Already broken by a peer that judged us stale; nothing to release.
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - fs.statSync(dir).mtimeMs > STALE_LOCK_MS) fs.rmdirSync(dir);
      } catch {
        // Raced with the holder releasing it; loop and try again.
      }
      if (Date.now() > deadline) throw new Error(`memory file is locked by another writer: ${path.basename(file)}`);
      Atomics.wait(sleeper, 0, 0, LOCK_POLL_MS);
    }
  }
}

/**
 * The one write path for shared memory: lock, re-read, apply against the FRESH entries, write,
 * unlock. A caller that planned its batch against a stale view still gets its entries merged in;
 * an `old_text` that no longer matches (a peer removed it) fails the batch, which is the honest
 * answer. The cap is checked on the merged result.
 */
export function commitOperations(
  profileDir: string,
  target: MemoryFileRef,
  operations: readonly MemoryOperation[],
  cap: number
): ApplyResult {
  const file = memoryPath(profileDir, target);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const release = acquireLock(file);
  try {
    const result = applyOperations(readEntries(profileDir, target), operations, cap);
    if (!result.ok) return result;
    atomicWriteFileSync(NODE_IO, file, result.rendered, OWNER_ONLY);
    return result;
  } finally {
    release();
  }
}
