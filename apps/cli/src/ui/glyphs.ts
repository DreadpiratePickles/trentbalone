/**
 * The monochrome fallback vocabulary.
 *
 * In `none` mode colour carries no information, so every state must remain
 * readable from its glyph alone. These five glyphs are fixed by the style
 * contract; none of them is an emoji (no Extended_Pictographic codepoint).
 */

export const STATES = ["running", "needsApproval", "done", "failed", "idle"] as const;
export type AgentState = (typeof STATES)[number];

export const GLYPHS: Record<AgentState, string> = {
  running: "●", // BLACK CIRCLE
  needsApproval: "◆", // BLACK DIAMOND
  done: "✓", // CHECK MARK
  failed: "✗", // BALLOT X
  idle: "·", // MIDDLE DOT
};

/** The hollow counterpart used by the pulse-dot breathe. */
export const GLYPH_DOT_HOLLOW = "○"; // WHITE CIRCLE

/** Left rail marking the active row. Never a full-row invert. */
export const GLYPH_SELECTION = "▎"; // LEFT ONE QUARTER BLOCK

/** Box drawing used by the frame motifs. */
export const BOX = {
  h: "─",
  v: "│",
  tl: "┌",
  tr: "┐",
  bl: "└",
  br: "┘",
  bevel: "╱", // BOX DRAWINGS LIGHT DIAGONAL UPPER RIGHT TO LOWER LEFT
} as const;

/** The fading-rule ramp: solid, then progressively lighter, then blank. */
export const RULE_RAMP = ["━", "─", "┄", "┈"] as const;

export function glyphFor(state: AgentState): string {
  return GLYPHS[state];
}

/** Uppercase mono status label for a state. Sentence case is for prose only. */
export const STATE_LABEL: Record<AgentState, string> = {
  running: "RUNNING",
  needsApproval: "NEEDS APPROVAL",
  done: "DONE",
  failed: "FAILED",
  idle: "IDLE",
};
