/**
 * The bytes a `kind: "memory"` draft carries and the one way they reach disk.
 *
 * A memory draft's `content` (and every ledger `before`/`after` for it) is this JSON payload:
 * every block as canonical rendered entries, the itemised operations that produced them ([C4]),
 * the entries they dropped, and the profile the files live in — so a ledger row is enough to
 * restore the files on `rollback`, the same way a skill's prior bytes are enough to restore the
 * row, and enough to review HOW the block changed. Writes go through the memory tool's
 * `commitOperations`: lock, re-read, remove every entry the file holds, add the target bytes'
 * entries, cap-check on the merged result, write-then-rename 0600. The result is the target
 * bytes exactly; a seat committing inside the lock window is merged by the tool or fails the
 * batch honestly, and the caller sees the reason.
 */
import { z } from "zod";

import {
  CONSOLIDATION_WRITE_GATE,
  ENTRY_SEPARATOR,
  MEMORY_CAPS,
  applyOperations,
  checkMemoryWriteGate,
  commitOperations,
  commitReplaceAll,
  readEntries,
  render,
  type MemoryOperation,
  type MemoryTarget,
  type MemoryWriteGate,
} from "../tools/memory/store.js";
import { MemoryOpSchema, type MemoryOp } from "./memory-ops.js";

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

/** [C4] The itemised change to one block, kept beside the text it produced. */
export interface MemoryBlockOps {
  readonly label: string;
  readonly ops: readonly MemoryOp[];
}

export interface MemoryDraftPayload extends MemoryBytes {
  readonly profileDir: string;
  /** Entries the consolidation removed or merged away, for the founder to see. */
  readonly dropped: readonly string[];
  /**
   * [C4] The operations the proposal is made of, in block order. The resulting text above is what
   * promotion writes and what a rollback restores — byte-exact either way — and this is the
   * reviewable account of how it got there. Absent when nothing was proposed (a `before` payload).
   */
  readonly ops?: readonly MemoryBlockOps[];
}

const BlockSchema = z.object({
  label: z.string().min(1),
  file: z.string().min(1),
  limit: z.number().int().positive(),
  text: z.string(),
});

const BlockOpsSchema = z.object({ label: z.string().min(1), ops: z.array(MemoryOpSchema) });

const PayloadSchema = z.object({
  profileDir: z.string().min(1),
  memory: z.string(),
  user: z.string(),
  dropped: z.array(z.string()),
  blocks: z.array(BlockSchema).optional(),
  ops: z.array(BlockOpsSchema).optional(),
});

export function encodeMemoryDraft(payload: MemoryDraftPayload): string {
  const blocks = payload.blocks ?? [];
  const ops = payload.ops ?? [];
  return JSON.stringify({
    profileDir: payload.profileDir,
    memory: payload.memory,
    user: payload.user,
    dropped: [...payload.dropped],
    ...(blocks.length === 0 ? {} : { blocks: blocks.map((b) => ({ label: b.label, file: b.file, limit: b.limit, text: b.text })) }),
    ...(ops.length === 0 ? {} : { ops: ops.map((b) => ({ label: b.label, ops: [...b.ops] })) }),
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

/**
 * [C4] Writing a whole block is the consolidation layer's job, so every call here carries the
 * consolidation gate. `consolidationMayEdit` is what lets a `read_only` block be written at all,
 * and by default it is nothing.
 */
function gateFor(mayEdit: readonly string[] = []): MemoryWriteGate {
  return mayEdit.length === 0 ? CONSOLIDATION_WRITE_GATE : { writer: "consolidation", consolidationMayEdit: [...mayEdit] };
}

/** Would replacing the block succeed against the file as it is now? A reason when not. */
export function checkReplaceBlock(profileDir: string, target: BlockRef, rendered: string, mayEdit: readonly string[] = []): string | null {
  const gated = checkMemoryWriteGate(target, [{ action: "replace" }], gateFor(mayEdit));
  if (gated !== null) return gated;
  const current = readEntries(profileDir, target);
  if (new Set(current).size !== current.length) {
    const size = render(canonicalEntries(rendered)).length;
    return size > capOf(target) ? `the result would be ${size} chars, over the ${capOf(target)}-char cap by ${size - capOf(target)}` : null;
  }
  const result = applyOperations(current, replaceAllOperations(current, canonicalEntries(rendered)), capOf(target));
  return result.ok ? null : result.reason;
}

/**
 * Replace one block under the memory tool's lock. A file holding byte-identical duplicate entries
 * cannot be addressed by `old_text` at all (the tool refuses an ambiguous match), so that one case
 * — the case consolidation exists to clean up — is written whole. It used to be written with no
 * lock at all, which meant a seat's append could vanish between this function's read and its
 * rename; `commitReplaceAll` takes the SAME lock every other writer takes (fleet audit 3.3).
 */
export function replaceBlock(profileDir: string, target: BlockRef, rendered: string, mayEdit: readonly string[] = []): void {
  const next = canonicalEntries(rendered);
  const current = readEntries(profileDir, target);
  const cap = capOf(target);
  const label = labelOf(target);
  const gate = gateFor(mayEdit);
  const result =
    new Set(current).size !== current.length
      ? commitReplaceAll(profileDir, target, render(next), cap, gate)
      : commitOperations(profileDir, target, replaceAllOperations(current, next), cap, gate);
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
  // [C4] The draft's own block list is the permission: a read-only block reaches a draft only
  // because it was listed under `memory.consolidation_may_edit` when the turn was made, and a
  // human promoted what came out. Nothing else may put one here.
  const mayEdit = (bytes.blocks ?? []).map((block) => block.label);
  for (const step of plan) {
    const reason = checkReplaceBlock(profileDir, step.ref, step.text, mayEdit);
    if (reason !== null) throw new Error(`memory(${step.label}) refused: ${reason}`);
  }
  const previous = readMemoryBytes(profileDir, bytes.blocks ?? []);
  const written: typeof plan = [];
  try {
    for (const step of plan) {
      replaceBlock(profileDir, step.ref, step.text, mayEdit);
      written.push(step);
    }
  } catch (error) {
    for (const step of written.reverse()) {
      try {
        replaceBlock(profileDir, step.ref, priorText(previous, step.label), mayEdit);
      } catch {
        // The original failure is the one worth raising; a failed revert must not mask it.
      }
    }
    throw error;
  }
}
