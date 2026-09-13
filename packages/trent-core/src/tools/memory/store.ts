/**
 * The two memory files and the rule that governs them: a hard character cap checked on the FINAL
 * state of a batch, so a seat can remove-and-add in one atomic operation. Writes are temp-file
 * then rename, owner-only, and a failed batch leaves the file byte-identical.
 */
import fs from "node:fs";
import path from "node:path";
import { NODE_IO, atomicWriteFileSync } from "../../config/atomic-fs.js";

export type MemoryTarget = "memory" | "user";
export type MemoryAction = "add" | "replace" | "remove";

export const MEMORY_CAPS: Record<MemoryTarget, number> = { memory: 2200, user: 1375 };
export const MEMORY_FILES: Record<MemoryTarget, string> = { memory: "MEMORY.md", user: "USER.md" };
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

export function memoryPath(profileDir: string, target: MemoryTarget): string {
  return path.join(profileDir, "memories", MEMORY_FILES[target]);
}

export function readEntries(profileDir: string, target: MemoryTarget): string[] {
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
export function writeEntries(profileDir: string, target: MemoryTarget, rendered: string): void {
  const file = memoryPath(profileDir, target);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteFileSync(NODE_IO, file, rendered, OWNER_ONLY);
}
