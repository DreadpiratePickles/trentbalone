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

/** Enough of a configured block to address its file and check its cap; a `MemoryBlock` is one. */
export interface MemoryBlockSpec {
  readonly label: string;
  readonly file: string;
  readonly limit: number;
}

export interface MemoryBlockBytes extends MemoryBlockSpec {
  readonly text: string;
}

export interface MemoryBytes {
  readonly memory: string;
  readonly user: string;
  /**
   * Configured blocks beyond the two defaults (`config.memory.blocks`), each with its own cap.
   * Absent — not an empty list — when the profile adds none, so a default draft's bytes and its
   * encoded payload are exactly what they were before named blocks existed.
   */
  readonly blocks?: readonly MemoryBlockBytes[];
}

export interface MemoryDraftPayload extends MemoryBytes {
  readonly profileDir: string;
  /** Entries the rewrite removed (merged into another or no longer true), for the founder to see. */
  readonly dropped: readonly string[];
}

const BlockSchema = z.object({
  label: z.string().min(1),
  file: z.string().min(1),
  limit: z.number().int().positive(),
  text: z.string(),
});

const PayloadSchema = z.object({
  profileDir: z.string().min(1),
  memory: z.string(),
  user: z.string(),
  dropped: z.array(z.string()),
  blocks: z.array(BlockSchema).optional(),
});

export function encodeMemoryDraft(payload: MemoryDraftPayload): string {
  const blocks = payload.blocks ?? [];
  return JSON.stringify({
    profileDir: payload.profileDir,
    memory: payload.memory,
    user: payload.user,
    dropped: [...payload.dropped],
    ...(blocks.length === 0 ? {} : { blocks: blocks.map((b) => ({ label: b.label, file: b.file, limit: b.limit, text: b.text })) }),
  });
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

export function readMemoryBytes(profileDir: string, blocks: readonly MemoryBlockSpec[] = []): MemoryBytes {
  const extra = blocks.map((b): MemoryBlockBytes => ({ label: b.label, file: b.file, limit: b.limit, text: render(readEntries(profileDir, b)) }));
  return {
    memory: render(readEntries(profileDir, "memory")),
    user: render(readEntries(profileDir, "user")),
    ...(extra.length === 0 ? {} : { blocks: extra }),
  };
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

/** A legacy label carries the default cap; a configured block carries its own. */
export type BlockRef = MemoryTarget | MemoryBlockSpec;

function capOf(ref: BlockRef): number {
  return typeof ref === "string" ? MEMORY_CAPS[ref] : ref.limit;
}

function labelOf(ref: BlockRef): string {
  return typeof ref === "string" ? ref : ref.label;
}

/** Would replacing the block succeed against the file as it is now? A reason when not. */
export function checkReplaceBlock(profileDir: string, target: BlockRef, rendered: string): string | null {
  const current = readEntries(profileDir, target);
  if (new Set(current).size !== current.length) return null;
  const result = applyOperations(current, replaceAllOperations(current, canonicalEntries(rendered)), capOf(target));
  return result.ok ? null : result.reason;
}

/**
 * Replace one block under the memory tool's lock. A file holding byte-identical duplicate entries
 * cannot be addressed by `old_text` at all (the tool refuses an ambiguous match), so that one case
 * — the case consolidation exists to clean up — takes the tool's atomic write directly.
 */
export function replaceBlock(profileDir: string, target: BlockRef, rendered: string): void {
  const next = canonicalEntries(rendered);
  const current = readEntries(profileDir, target);
  const cap = capOf(target);
  const label = labelOf(target);
  if (new Set(current).size !== current.length) {
    const size = render(next).length;
    if (size > cap) throw new Error(`memory(${label}): ${size} chars is over the ${cap}-char cap`);
    writeEntries(profileDir, target, render(next));
    return;
  }
  const result = commitOperations(profileDir, target, replaceAllOperations(current, next), cap);
  if (!result.ok) throw new Error(`memory(${label}) refused: ${result.reason}`);
}

/** MEMORY.md, USER.md, then every extra configured block the draft carries, in that order. */
function writePlan(bytes: MemoryBytes): Array<{ ref: BlockRef; label: string; text: string }> {
  return [
    ...MEMORY_TARGETS.map((target) => ({ ref: target as BlockRef, label: target as string, text: bytes[target] })),
    ...(bytes.blocks ?? []).map((b) => ({ ref: { label: b.label, file: b.file, limit: b.limit } as BlockRef, label: b.label, text: b.text })),
  ];
}

function priorText(previous: MemoryBytes, label: string): string {
  if (label === "memory" || label === "user") return previous[label];
  return (previous.blocks ?? []).find((b) => b.label === label)?.text ?? "";
}

/**
 * Every block the draft carries, MEMORY.md and USER.md first. Each write is atomic on its own;
 * the whole set is checked against the current files before any is touched, and a failure part
 * way through puts the already-written files back, so the blocks never disagree about which
 * version they are.
 */
export function applyMemoryBytes(profileDir: string, bytes: MemoryBytes): void {
  const plan = writePlan(bytes);
  for (const step of plan) {
    const reason = checkReplaceBlock(profileDir, step.ref, step.text);
    if (reason !== null) throw new Error(`memory(${step.label}) refused: ${reason}`);
  }
  const previous = readMemoryBytes(profileDir, bytes.blocks ?? []);
  const written: typeof plan = [];
  try {
    for (const step of plan) {
      replaceBlock(profileDir, step.ref, step.text);
      written.push(step);
    }
  } catch (error) {
    for (const step of written.reverse()) {
      try {
        replaceBlock(profileDir, step.ref, priorText(previous, step.label));
      } catch {
        // The original failure is the one worth raising; a failed revert must not mask it.
      }
    }
    throw error;
  }
}
