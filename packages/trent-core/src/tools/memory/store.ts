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
  /**
   * A refusal carries the state the batch was judged against: the entries as they are on disk
   * right now, the characters they use and the limit they were measured against. A seat that is
   * over the limit can therefore consolidate in the SAME turn — remove and add in one batch —
   * instead of guessing from a prelude snapshot that was frozen before this write.
   */
  | { ok: false; reason: string; entries?: string[]; used?: number; limit?: number };

/**
 * Where a write learns its limit. A caller with the configured block list (`config.memory.blocks`)
 * passes it and the limit is resolved from it; a caller with a number passes the number.
 */
export interface MemoryLimitSource {
  readonly blocks?: readonly MemoryBlock[];
}

/**
 * [C4] Which layer is writing. Letta's rule, and the one this file enforces: an append is safe
 * from anyone, a rewrite has exactly one owner.
 *
 * - `seat`: the `memory` tool in a run. Episodic appends only; `replace` and `remove` are refused.
 * - `consolidation`: the scheduled consolidation draft and its human-promoted write
 *   (`fleet-memory/consolidate.ts`, `fleet-memory/memory-draft.ts`). Every action, and — only for
 *   the labels `memory.consolidation_may_edit` lists — a `read_only` block as well.
 */
export type MemoryWriter = "seat" | "consolidation";

export interface MemoryWriteGate {
  readonly writer: MemoryWriter;
  /** `config.memory.consolidation_may_edit`: read-only labels the consolidation path may edit. */
  readonly consolidationMayEdit?: readonly string[];
  /** The configured blocks, when the target ref does not carry its own write rule. */
  readonly blocks?: readonly MemoryBlock[];
}

/** The default for any caller that does not say: the most restricted layer. */
export const SEAT_WRITE_GATE: MemoryWriteGate = { writer: "seat" };
/** The consolidation path with no read-only block listed; `consolidationMayEdit` adds those. */
export const CONSOLIDATION_WRITE_GATE: MemoryWriteGate = { writer: "consolidation" };

/** The label a ref addresses: the legacy label itself, or the configured block's own. */
function refLabel(target: MemoryFileRef): string | undefined {
  return typeof target === "string" ? target : (target as Partial<MemoryBlock>).label;
}

/**
 * The character limit for one block: the CONFIGURED block with that label or file wins, and the
 * shipped cap is the fallback. Without this the legacy labels `"memory"` and `"user"` always
 * resolved to `MEMORY_CAPS`, so raising `memory.blocks[].limit` in config changed the prelude and
 * the consolidation prompt but not the write that actually refuses.
 */
export function memoryLimit(
  target: MemoryFileRef,
  blocks: readonly MemoryBlock[] = DEFAULT_MEMORY_BLOCKS,
): number {
  const file = memoryFileName(target);
  const label = refLabel(target);
  const configured = blocks.find((b) => b.file === file || (label !== undefined && b.label === label));
  if (configured) return configured.limit;

  const own = (target as Partial<MemoryBlock>).limit;
  if (typeof own === "number") return own;

  const shipped = DEFAULT_MEMORY_BLOCKS.find((b) => b.file === file || (label !== undefined && b.label === label));
  if (shipped) return shipped.limit;
  throw new Error(`no memory block declares a limit for ${file}`);
}

/** The file name a target resolves to: the block's own, or the default block for a legacy label. */
export function memoryFileName(target: MemoryFileRef): string {
  return typeof target === "string" ? MEMORY_FILES[target] : target.file;
}

export function memoryPath(profileDir: string, target: MemoryFileRef): string {
  return path.join(profileDir, "memories", memoryFileName(target));
}

/** The write rule for one target: the ref's own when it carries it, else the configured block's. */
export function memoryBlockIsReadOnly(target: MemoryFileRef, blocks?: readonly MemoryBlock[]): boolean {
  const own = (target as Partial<MemoryBlock>).read_only;
  if (typeof own === "boolean") return own;
  const file = memoryFileName(target);
  const label = refLabel(target);
  const configured = (blocks ?? DEFAULT_MEMORY_BLOCKS).find((b) => b.file === file || (label !== undefined && b.label === label));
  return configured?.read_only ?? false;
}

/**
 * Refuses a write the layer rules forbid; null when the batch may proceed. Checked before the
 * lock is taken, because a refusal reads nothing and changes nothing.
 */
export function checkMemoryWriteGate(
  target: MemoryFileRef,
  operations: readonly MemoryOperation[],
  gate: MemoryWriteGate = SEAT_WRITE_GATE,
): string | null {
  const file = memoryFileName(target);
  const label = refLabel(target) ?? file;
  if (memoryBlockIsReadOnly(target, gate.blocks)) {
    const listed = gate.writer === "consolidation" && (gate.consolidationMayEdit ?? []).includes(label);
    if (!listed) {
      return (
        `${file} is read-only: the founder edits it by hand. ` +
        `Only the scheduled consolidation may write it, and only while "${label}" is listed under memory.consolidation_may_edit.`
      );
    }
  }
  if (gate.writer === "seat") {
    // Only the two rewrite actions are gated; an action this file does not know at all is a
    // malformed call, and `applyOperations` is the one place that says so.
    const rewrite = operations.find((op) => op.action === "replace" || op.action === "remove");
    if (rewrite) {
      return (
        `a seat may only add entries to ${file}; "${rewrite.action}" changes an entry the block already carries. ` +
        "Entries are replaced, merged and removed by the scheduled memory consolidation, which the founder promotes."
      );
    }
  }
  return null;
}

/** The entries a rendered block holds: split on the separator, trimmed, empties dropped. */
export function parseEntries(raw: string): string[] {
  if (!raw.trim()) return [];
  return raw.split(ENTRY_SEPARATOR).map((e) => e.trim()).filter(Boolean);
}

export function readEntries(profileDir: string, target: MemoryFileRef): string[] {
  const file = memoryPath(profileDir, target);
  if (!fs.existsSync(file)) return [];
  return parseEntries(fs.readFileSync(file, "utf8"));
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
  /** Every refusal reports the state it judged, not only the sentence explaining itself. */
  const refuse = (reason: string): ApplyResult => ({
    ok: false,
    reason,
    entries: [...entries],
    used: render([...entries]).length,
    limit: cap,
  });
  const next = [...entries];
  for (const [i, op] of operations.entries()) {
    const label = `operation ${i + 1} (${op.action})`;
    const content = typeof op.content === "string" ? op.content.trim() : "";
    const oldText = typeof op.old_text === "string" ? op.old_text.trim() : "";
    if (content.includes(ENTRY_SEPARATOR.trim())) {
      return refuse(`${label}: content may not contain the entry separator "${ENTRY_SEPARATOR.trim()}"`);
    }
    switch (op.action) {
      case "add": {
        if (!content) return refuse(`${label}: "content" is required`);
        next.push(content);
        break;
      }
      case "replace":
      case "remove": {
        if (!oldText) return refuse(`${label}: "old_text" is required`);
        if (op.action === "replace" && !content) return refuse(`${label}: "content" is required`);
        const idx = locate(next, oldText);
        if (idx === -1) return refuse(`${label}: no entry contains "${oldText}"`);
        if (idx === -2) return refuse(`${label}: "${oldText}" matches more than one entry; be more specific`);
        if (op.action === "replace") next[idx] = content;
        else next.splice(idx, 1);
        break;
      }
      default:
        return refuse(`${label}: unknown action; use add, replace or remove`);
    }
  }
  const rendered = render(next);
  if (rendered.length > cap) {
    const current = render([...entries]).length;
    return refuse(
      `the result would be ${rendered.length} chars, over the ${cap}-char cap by ${rendered.length - cap}. ` +
        `The file is unchanged: ${current} chars used, ${cap - current} chars remaining. ` +
        `Shorten the entry: removing and merging entries is the scheduled consolidation's job, not a seat's.`,
    );
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
 *
 * `limit` is either the number the caller already resolved, or the configured block list to
 * resolve it from — pass `{ blocks: config.memory.blocks }` and an override of a DEFAULT block's
 * limit is what this write enforces. With neither, the shipped cap applies.
 */
export function commitOperations(
  profileDir: string,
  target: MemoryFileRef,
  operations: readonly MemoryOperation[],
  limit: number | MemoryLimitSource = {},
  gate: MemoryWriteGate = SEAT_WRITE_GATE
): ApplyResult {
  const cap = typeof limit === "number" ? limit : memoryLimit(target, limit.blocks);
  const refused = checkMemoryWriteGate(target, operations, gate);
  if (refused !== null) return refuseWith(profileDir, target, refused, cap);
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

/** A refusal that never reached `applyOperations` still reports the block it was judged against. */
function refuseWith(profileDir: string, target: MemoryFileRef, reason: string, cap: number): ApplyResult {
  const entries = readEntries(profileDir, target);
  return { ok: false, reason, entries, used: render(entries).length, limit: cap };
}

/**
 * [C4] The one way a whole block is replaced, and the write path that closed the lock bypass in
 * `fleet-memory/memory-draft.ts`. A block holding byte-identical duplicate entries cannot be
 * addressed by `old_text` at all (the tool refuses an ambiguous match) — which is exactly the case
 * consolidation exists to clean up — so the target bytes are written whole. Under the SAME lock as
 * every other writer: a seat's append in the window is serialised before or after this write, never
 * interleaved with it, and the rename is still atomic.
 */
export function commitReplaceAll(
  profileDir: string,
  target: MemoryFileRef,
  rendered: string,
  limit: number | MemoryLimitSource = {},
  gate: MemoryWriteGate = SEAT_WRITE_GATE
): ApplyResult {
  const cap = typeof limit === "number" ? limit : memoryLimit(target, limit.blocks);
  const refused = checkMemoryWriteGate(target, [{ action: "replace" }], gate);
  if (refused !== null) return refuseWith(profileDir, target, refused, cap);
  const file = memoryPath(profileDir, target);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const release = acquireLock(file);
  try {
    if (rendered.length > cap) return refuseWith(profileDir, target, `the result would be ${rendered.length} chars, over the ${cap}-char cap by ${rendered.length - cap}`, cap);
    atomicWriteFileSync(NODE_IO, file, rendered, OWNER_ONLY);
    const entries = parseEntries(rendered);
    return { ok: true, entries, rendered, remaining: cap - rendered.length };
  } finally {
    release();
  }
}
