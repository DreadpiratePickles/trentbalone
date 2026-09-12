/**
 * 3.6 — the slash-command dropdown.
 *
 * Filtering is on the TOKEN UNDER THE CURSOR. The previous implementation used
 * readline's completer, which is handed the whole line, so a command could only ever be
 * completed when the line was otherwise empty.
 */

import { GLYPH_SELECTION, truncate, type Theme } from "../ui/index.js";

export interface Token {
  token: string;
  start: number;
  end: number;
}

const SEPARATOR = /\s/;

/** The whitespace-delimited token the cursor sits in or immediately after. */
export function tokenUnderCursor(line: string, cursor: number): Token {
  const at = Math.max(0, Math.min(cursor, line.length));
  let start = at;
  while (start > 0 && !SEPARATOR.test(line[start - 1]!)) start -= 1;
  let end = at;
  while (end < line.length && !SEPARATOR.test(line[end]!)) end += 1;
  return { token: line.slice(start, end), start, end };
}

export interface Completion extends Token {
  open: boolean;
  matches: string[];
}

/** Open only on a slash token; matches are prefix matches on the text after the slash. */
export function autocomplete(line: string, cursor: number, names: readonly string[]): Completion {
  const found = tokenUnderCursor(line, cursor);
  if (!found.token.startsWith("/")) return { ...found, open: false, matches: [] };
  const prefix = found.token.slice(1).toLowerCase();
  return { ...found, open: true, matches: names.filter((name) => name.startsWith(prefix)) };
}

/** Replaces just the token under the cursor, leaving the rest of the line intact. */
export function applyCompletion(line: string, cursor: number, choice: string): { line: string; cursor: number } {
  const { start, end } = tokenUnderCursor(line, cursor);
  const replacement = `/${choice}`;
  return {
    line: line.slice(0, start) + replacement + line.slice(end),
    cursor: start + replacement.length,
  };
}

/** The dropdown. The active row carries the mint left rail, never a full-row invert. */
export function renderDropdown(matches: readonly string[], selected: number, theme: Theme, width: number): string[] {
  return matches.map((name, index) => {
    const active = index === selected;
    const rail = active ? theme.accent(GLYPH_SELECTION) : " ";
    const label = truncate(`/${name}`, Math.max(1, width - 2));
    return `${rail} ${active ? theme.emphasis(label) : theme.body(label)}`;
  });
}
