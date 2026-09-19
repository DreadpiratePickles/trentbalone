/**
 * [C4] A memory change is an itemised delta over the entries of ONE block, never a new copy of
 * the block.
 *
 * Asking a model for a rewritten block is what collapses a context: ACE measured a context of
 * 18,282 tokens at 66.7 percent accuracy becoming 122 tokens at 57.1 percent in a single
 * "rewrite this" step, because everything the model failed to restate simply ceased to exist.
 * The fix is to make omission impossible to express. The model never sees a blank page: it sees
 * the block's entries, each addressed by an id, and answers with operations over those ids.
 * Code — not the model — decides what the block becomes.
 *
 * The four operations are the whole vocabulary:
 *   `append {text}`                    a fact the block does not carry yet
 *   `replace {entry_id, text}`         this entry should read differently
 *   `remove {entry_id}`                this entry is no longer true
 *   `merge {entry_ids[], text}`        these entries say the same thing; here is the one entry
 *
 * Everything is validated before anything is applied, and a proposal is all-or-nothing: an
 * unknown operation, an id the block does not have, an entry addressed twice, or a shrink past
 * the per-turn cap rejects the WHOLE list. The cap is the collapse guard: at most
 * `DEFAULT_MAX_REMOVAL_RATIO` of the entries may be removed or merged away in one consolidation
 * (never fewer than one, so a three-entry block can still lose its duplicate).
 *
 * A refusal carries the block as it stands — entries, characters used, the limit — the same
 * shape `tools/memory/store.ts` returns, so every writer reports a limit the same way.
 */
import { z } from "zod";

import { ENTRY_SEPARATOR, render } from "../tools/memory/store.js";

export const MEMORY_OP_NAMES = ["append", "replace", "remove", "merge"] as const;
export type MemoryOpName = (typeof MEMORY_OP_NAMES)[number];

const SEPARATOR_TOKEN = ENTRY_SEPARATOR.trim();

export const MemoryOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("append"), text: z.string() }),
  z.object({ op: z.literal("replace"), entry_id: z.string(), text: z.string() }),
  z.object({ op: z.literal("remove"), entry_id: z.string() }),
  z.object({ op: z.literal("merge"), entry_ids: z.array(z.string()), text: z.string() }),
]);
export type MemoryOp = z.infer<typeof MemoryOpSchema>;

/** Entries are addressed by position, 1-based: the ids are regenerated on every turn from disk. */
export function entryIdAt(index: number): string {
  return `e${index + 1}`;
}

/** The block as the model sees it: one line per entry, its id in front. Empty block, empty text. */
export function addressEntries(entries: readonly string[]): string {
  return entries.map((entry, i) => `[${entryIdAt(i)}] ${entry}`).join("\n");
}

/** At most this share of a block's entries may be removed or merged away in one consolidation. */
export const DEFAULT_MAX_REMOVAL_RATIO = 0.3;

/**
 * How many entries one turn may take out of a block of `count`. Rounded down, floored at one:
 * without the floor a block of three could never lose the duplicate consolidation exists for.
 */
export function removalAllowance(count: number, ratio: number = DEFAULT_MAX_REMOVAL_RATIO): number {
  return Math.max(1, Math.floor(count * ratio));
}

export type MemoryOpsResult =
  | { ok: true; entries: string[]; rendered: string; remaining: number; dropped: string[] }
  /** The same refusal shape the store returns: what the proposal was judged against. */
  | { ok: false; reason: string; entries: string[]; used: number; limit: number };

export interface ApplyMemoryOpsOptions {
  /** Overrides `DEFAULT_MAX_REMOVAL_RATIO` (config `memory.consolidation_max_removal_ratio`). */
  readonly maxRemovalRatio?: number;
}

/** Parses the list a model proposed. Anything but the four operations is a reason to reject. */
export function parseMemoryOps(value: unknown): { ok: true; ops: MemoryOp[] } | { ok: false; reason: string } {
  if (!Array.isArray(value)) return { ok: false, reason: "the operations for a block must be a list" };
  const known = MEMORY_OP_NAMES.join(", ");
  for (const [i, raw] of value.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: `operation ${i + 1} is not an object` };
    const name = (raw as { op?: unknown }).op;
    if (typeof name !== "string") return { ok: false, reason: `operation ${i + 1} carries no "op"; the operations are ${known}`};
    if (!(MEMORY_OP_NAMES as readonly string[]).includes(name)) {
      return { ok: false, reason: `operation ${i + 1}: unknown operation "${name}"; the operations are ${known}` };
    }
  }
  const parsed = z.array(MemoryOpSchema).safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, reason: `the operations did not match the schema: ${issue ? `${issue.path.join(".") || "root"} ${issue.message}` : "unknown"}` };
  }
  return { ok: true, ops: parsed.data };
}

/** The ids one operation addresses; an append addresses none. */
function targetsOf(op: MemoryOp): readonly string[] {
  if (op.op === "merge") return op.entry_ids;
  if (op.op === "append") return [];
  return [op.entry_id];
}

/** Entries this operation takes out of the block: a merge of n leaves one, so n-1 are gone. */
function shrinkOf(op: MemoryOp): number {
  if (op.op === "remove") return 1;
  if (op.op === "merge") return op.entry_ids.length - 1;
  return 0;
}

/**
 * Validate the whole list against the block as it is, then apply it deterministically: replaces
 * and merges land in the position of the entry they address, removes take the entry out, appends
 * go to the end in the order they were proposed. Nothing is applied unless everything validated.
 */
export function applyMemoryOps(
  entries: readonly string[],
  ops: readonly MemoryOp[],
  limit: number,
  options: ApplyMemoryOpsOptions = {},
): MemoryOpsResult {
  const current = [...entries];
  const used = render(current).length;
  const refuse = (reason: string): MemoryOpsResult => ({ ok: false, reason, entries: current, used, limit });

  const ids = current.map((_, i) => entryIdAt(i));
  const index = new Map(ids.map((id, i) => [id, i] as const));
  const claimed = new Set<string>();

  for (const [i, op] of ops.entries()) {
    const label = `operation ${i + 1} (${op.op})`;
    if (op.op !== "remove") {
      const text = op.text.trim();
      if (!text) return refuse(`${label}: "text" is required`);
      if (text.includes(SEPARATOR_TOKEN)) return refuse(`${label}: "text" may not contain the entry separator "${SEPARATOR_TOKEN}"`);
    }
    if (op.op === "merge") {
      if (op.entry_ids.length < 2) return refuse(`${label}: a merge addresses at least two entries`);
      if (new Set(op.entry_ids).size !== op.entry_ids.length) return refuse(`${label}: the same entry is merged twice`);
    }
    for (const id of targetsOf(op)) {
      if (!index.has(id)) return refuse(`${label}: this block has no entry ${id}; its entries are ${ids.join(", ") || "none"}`);
      if (claimed.has(id)) return refuse(`${label}: entry ${id} is already addressed by an earlier operation`);
      claimed.add(id);
    }
  }

  const shrink = ops.reduce((n, op) => n + shrinkOf(op), 0);
  const allowance = removalAllowance(current.length, options.maxRemovalRatio ?? DEFAULT_MAX_REMOVAL_RATIO);
  if (shrink > allowance) {
    return refuse(
      `the proposal takes ${shrink} of ${current.length} entries out of the block; at most ${allowance} may be removed or merged away in one consolidation. ` +
        "The whole proposal is refused.",
    );
  }

  const slots = current.map((text) => ({ text, live: true, dropped: false }));
  const appended: string[] = [];
  for (const op of ops) {
    switch (op.op) {
      case "append":
        appended.push(op.text.trim());
        break;
      case "replace":
        slots[index.get(op.entry_id)!]!.text = op.text.trim();
        break;
      case "remove": {
        const slot = slots[index.get(op.entry_id)!]!;
        slot.live = false;
        slot.dropped = true;
        break;
      }
      case "merge": {
        const positions = op.entry_ids.map((id) => index.get(id)!).sort((a, b) => a - b);
        for (const position of positions) slots[position]!.dropped = true;
        for (const position of positions.slice(1)) slots[position]!.live = false;
        slots[positions[0]!]!.text = op.text.trim();
        break;
      }
    }
  }

  const next = [...slots.filter((slot) => slot.live).map((slot) => slot.text), ...appended];
  const rendered = render(next);
  if (rendered.length > limit) {
    return refuse(
      `the result would be ${rendered.length} chars, over the ${limit}-char cap by ${rendered.length - limit}. ` +
        `The block is unchanged: ${used} chars used, ${limit - used} chars remaining.`,
    );
  }
  return { ok: true, entries: next, rendered, remaining: limit - rendered.length, dropped: current.filter((_, i) => slots[i]!.dropped) };
}
