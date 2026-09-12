/**
 * The motifs, translated from the app's own CSS (Milestone 3.2).
 *
 *  - HUD frame       <- .hub-frame (landing-hub.css:80-97): a dim slate border whose
 *                       ::before / ::after draw mint L-brackets at top-left and
 *                       bottom-right ONLY.
 *  - Fading rule     <- .pagehead::after: starts mint, decays to haze, then blank.
 *  - Pulse dot       <- pulse-ring 2.4s: a two-frame breathe.
 *  - Selection bar   <- .nav-item[data-active]: a mint left rail, never a row invert.
 *  - Beveled box     <- the 10px clipped bottom-right corner of the beveled button.
 *
 * Every function takes an explicit width and must never emit a line wider than it.
 */

import { BOX, GLYPHS, GLYPH_DOT_HOLLOW, GLYPH_SELECTION, RULE_RAMP } from "./glyphs.js";
import type { Theme } from "./theme.js";

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const ELLIPSIS = "…";

/** Printable width of a rendered string, ignoring SGR escapes. */
export function visibleWidth(line: string): number {
  return Array.from(line.replace(ANSI_RE, "")).length;
}

/** Hard-truncate to `max` printable columns, marking the cut. Never widens. */
export function truncate(text: string, max: number): string {
  if (max <= 0) return "";
  const chars = Array.from(text.replace(ANSI_RE, ""));
  if (chars.length <= max) return chars.join("");
  if (max === 1) return ELLIPSIS;
  return chars.slice(0, max - 1).join("") + ELLIPSIS;
}

function fit(text: string, width: number): string {
  const t = truncate(text, width);
  return t + " ".repeat(Math.max(0, width - visibleWidth(t)));
}

// ── HUD frame ───────────────────────────────────────────────────────────────

function bracketLength(width: number): number {
  return Math.max(2, Math.min(5, Math.floor(width / 12)));
}

export function hudFrame(content: string[], width: number, theme: Theme): string[] {
  const w = Math.max(6, Math.floor(width));
  const b = bracketLength(w);
  const inner = w - 4;

  const top =
    theme.accent(BOX.tl + BOX.h.repeat(b - 1)) +
    theme.border(BOX.h.repeat(w - b - 1) + BOX.tr);

  const bottom =
    theme.border(BOX.bl + BOX.h.repeat(w - b - 1)) +
    theme.accent(BOX.h.repeat(b - 1) + BOX.br);

  const body = content.map(
    (line) => theme.border(BOX.v) + " " + theme.body(fit(line, inner)) + " " + theme.border(BOX.v),
  );

  return [top, ...body, bottom];
}

// ── Fading rule ─────────────────────────────────────────────────────────────

export function fadingRule(width: number, theme: Theme): string {
  const w = Math.max(3, Math.floor(width));
  const run = Math.max(3, Math.floor(w * 0.7));
  const head = Math.max(1, Math.round(run * 0.25));
  const mid = Math.max(1, Math.round(run * 0.35));
  const tail = Math.max(1, run - head - mid);

  return (
    theme.accent(RULE_RAMP[0]!.repeat(head)) +
    theme.dim(RULE_RAMP[2]!.repeat(mid)) +
    theme.border(RULE_RAMP[3]!.repeat(tail))
  );
}

// ── Pulse dot ───────────────────────────────────────────────────────────────

export const PULSE_PERIOD_MS = 2400;
export type PulseFrame = 0 | 1;

export function pulseFrameAt(elapsedMs: number): PulseFrame {
  const phase = ((elapsedMs % PULSE_PERIOD_MS) + PULSE_PERIOD_MS) % PULSE_PERIOD_MS;
  return phase < PULSE_PERIOD_MS / 2 ? 0 : 1;
}

export function pulseDot(frame: PulseFrame, theme: Theme): string {
  return theme.accent(frame === 0 ? GLYPHS.running : GLYPH_DOT_HOLLOW);
}

// ── Selection bar ───────────────────────────────────────────────────────────

export function selectionBar(text: string, width: number, theme: Theme, selected: boolean): string {
  const w = Math.max(3, Math.floor(width));
  const label = truncate(text, w - 2);
  return selected
    ? theme.accent(GLYPH_SELECTION) + " " + theme.emphasis(label)
    : "  " + theme.body(label);
}

// ── Beveled box ─────────────────────────────────────────────────────────────

export function beveledBox(content: string[], width: number, theme: Theme): string[] {
  const w = Math.max(6, Math.floor(width));
  const inner = w - 4;
  return [
    theme.border(BOX.tl + BOX.h.repeat(w - 2) + BOX.tr),
    ...content.map(
      (line) => theme.border(BOX.v) + " " + theme.body(fit(line, inner)) + " " + theme.border(BOX.v),
    ),
    theme.border(BOX.bl + BOX.h.repeat(w - 3)) + theme.dim(BOX.bevel),
  ];
}
