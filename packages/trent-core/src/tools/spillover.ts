/**
 * Output limits. The seat prompt re-injects EVERY prior tool summary on every model turn
 * (`model-gateway.ts:326-330`), so a summary is capped at `SUMMARY_LIMIT` characters. Anything
 * longer is written whole to `<profile>/cache/spillover/<id>.txt` (Hermes `tool_result_storage.py`)
 * and the summary keeps a head/tail window plus the path, which `read_file` may page through.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

/** Hermes's delegate cap: what a seat can carry back through its own prompt. */
export const SUMMARY_LIMIT = 24_000;
/** Hermes `tool_output_limits.py:14`: terminal output before head/tail truncation. */
export const TERMINAL_OUTPUT_LIMIT = 50_000;
/** Hermes `tool_result_storage.py`: the preview kept with a spilled result. */
export const SPILL_PREVIEW = 1_500;

export function spilloverDir(profileDir: string): string {
  return path.join(profileDir, "cache", "spillover");
}

/** Keeps `headRatio` of the budget from the start and the rest from the end (Hermes: 40/60). */
export function headTail(text: string, limit: number, headRatio = 0.4): string {
  if (text.length <= limit) return text;
  const omitted = text.length - limit;
  const marker = `\n... [${omitted} characters omitted] ...\n`;
  const budget = Math.max(0, limit - marker.length);
  const head = Math.floor(budget * headRatio);
  const tail = budget - head;
  return `${text.slice(0, head)}${marker}${tail > 0 ? text.slice(-tail) : ""}`;
}

/** Writes `text` to the spillover directory and returns the absolute path. */
export function spill(profileDir: string, label: string, text: string): string {
  const dir = spilloverDir(profileDir);
  mkdirSync(dir, { recursive: true });
  const id = `${label.replace(/[^a-z0-9_-]+/gi, "_").slice(0, 40)}-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const file = path.join(dir, `${id}.txt`);
  writeFileSync(file, text, { encoding: "utf8", mode: 0o600 });
  return file;
}

/**
 * Fits a tool result into the summary budget. Over budget, the full text is spilled and the
 * summary keeps a head/tail window with the spill path and the `read_file` hint.
 */
export function fitSummary(text: string, profileDir: string, label: string, limit = SUMMARY_LIMIT): string {
  if (text.length <= limit) return text;
  const file = spill(profileDir, label, text);
  const note =
    `\n[output was ${text.length} characters; full text saved to ${file} — ` +
    `read it with read_file {"path":"${file}","offset":N,"limit":M}]`;
  return headTail(text, Math.max(SPILL_PREVIEW, limit - note.length)) + note;
}
