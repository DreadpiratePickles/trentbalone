/**
 * The bytes a `kind: "memory"` draft carries and the one way they reach disk.
 *
 * A memory draft's `content` (and every ledger `before`/`after` for it) is this JSON payload:
 * both blocks as canonical rendered entries, the entries the rewrite dropped, and the profile the
 * files live in — so a ledger row is enough to restore the files on `rollback`, the same way a
 * skill's prior bytes are enough to restore the row. Writes go through the memory tool's
 * `commitOperations`: lock, re-read, remove every entry the file holds, add the target bytes'
 * entries, cap-check on the merged result, write-then-rename 0600. The result is the target
 * bytes exactly; a seat committing inside the lock window is merged by the tool or fails the
 * batch honestly, and the caller sees the reason.
 */
import { z } from "zod";

import {
  ENTRY_SEPARATOR,
  MEMORY_CAPS,
  applyOperations,
  commitOperations,
  readEntries,
  render,
  writeEntries,
  type MemoryOperation,
  type MemoryTarget,
} from "../tools/memory/store.js";

export const MEMORY_DRAFT_KIND = "memory" as const;
/** Company memory belongs to no seat; the fleet is the learning key, as `__org__` is for skills. */
export const MEMORY_DRAFT_AGENT = "__fleet__";
export const MEMORY_DRAFT_TASK_TYPE = "memory_consolidation";

export const MEMORY_TARGETS: readonly MemoryTarget[] = ["memory", "user"];

export interface MemoryBytes {
  readonly memory: string;
  readonly user: string;
}

export interface MemoryDraftPayload extends MemoryBytes {
  readonly profileDir: string;
  /** Entries the rewrite removed (merged into another or no longer true), for the founder to see. */
  readonly dropped: readonly string[];
}

const PayloadSchema = z.object({
  profileDir: z.string().min(1),
  memory: z.string(),
  user: z.string(),
  dropped: z.array(z.string()),
});

export function encodeMemoryDraft(payload: MemoryDraftPayload): string {
  return JSON.stringify({ profileDir: payload.profileDir, memory: payload.memory, user: payload.user, dropped: [...payload.dropped] });
}

/** Throws on anything that is not a memory draft payload; a ledger row of another kind never reaches this. */
export function decodeMemoryDraft(content: string): MemoryDraftPayload {
  return PayloadSchema.parse(JSON.parse(content));
}

/** The block as the memory tool would render it: entries split on the separator, trimmed, empties dropped. */
export function canonicalEntries(block: string): string[] {
  return block
    .split(ENTRY_SEPARATOR)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function canonicalBlock(block: string): string {
  return render(canonicalEntries(block));
}

export function readMemoryBytes(profileDir: string): MemoryBytes {
  return { memory: render(readEntries(profileDir, "memory")), user: render(readEntries(profileDir, "user")) };
}

function byLengthDesc(a: string, b: string): number {
  return b.length - a.length || a.localeCompare(b);
}

/**
 * Longest first, so removing an entry never also matches a longer one that contains it
 * (`old_text` must match exactly one entry).
 */
function replaceAllOperations(current: readonly string[], next: readonly string[]): MemoryOperation[] {
  return [
    ...[...new Set(current)].sort(byLengthDesc).map((entry): MemoryOperation => ({ action: "remove", old_text: entry })),
    ...next.map((entry): MemoryOperation => ({ action: "add", content: entry })),
  ];
}

/** Would replacing the block succeed against the file as it is now? A reason when not. */
export function checkReplaceBlock(profileDir: string, target: MemoryTarget, rendered: string): string | null {
  const current = readEntries(profileDir, target);
  if (new Set(current).size !== current.length) return null;
  const result = applyOperations(current, replaceAllOperations(current, canonicalEntries(rendered)), MEMORY_CAPS[target]);
  return result.ok ? null : result.reason;
}

/**
 * Replace one block under the memory tool's lock. A file holding byte-identical duplicate entries
 * cannot be addressed by `old_text` at all (the tool refuses an ambiguous match), so that one case
 * — the case consolidation exists to clean up — takes the tool's atomic write directly.
 */
export function replaceBlock(profileDir: string, target: MemoryTarget, rendered: string): void {
  const next = canonicalEntries(rendered);
  const current = readEntries(profileDir, target);
  const cap = MEMORY_CAPS[target];
  if (new Set(current).size !== current.length) {
    const size = render(next).length;
    if (size > cap) throw new Error(`memory(${target}): ${size} chars is over the ${cap}-char cap`);
    writeEntries(profileDir, target, render(next));
    return;
  }
  const result = commitOperations(profileDir, target, replaceAllOperations(current, next), cap);
  if (!result.ok) throw new Error(`memory(${target}) refused: ${result.reason}`);
}

/**
 * Both blocks, MEMORY.md then USER.md. Each write is atomic on its own; the pair is checked
 * against the current files before either is touched, and a failure on the second reverts the
 * first, so the two files never disagree about which version they are.
 */
export function applyMemoryBytes(profileDir: string, bytes: MemoryBytes): void {
  for (const target of MEMORY_TARGETS) {
    const reason = checkReplaceBlock(profileDir, target, bytes[target]);
    if (reason !== null) throw new Error(`memory(${target}) refused: ${reason}`);
  }
  const previous = readMemoryBytes(profileDir);
  replaceBlock(profileDir, "memory", bytes.memory);
  try {
    replaceBlock(profileDir, "user", bytes.user);
  } catch (error) {
    replaceBlock(profileDir, "memory", previous.memory);
    throw error;
  }
}
