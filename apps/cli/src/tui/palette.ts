/**
 * The Ink panes' colours, by role. Every value is quoted from `ui/theme.ts`, the one file
 * allowed to spell a hex; no TUI component writes one (anti-pattern #5).
 *
 * The grammar is the REPL's: pulse means Trent acted, ember means a human decision is
 * required, danger is reserved for failure. Everything else is a neutral.
 */

import { AGENT_CATEGORY_HEX, TOKEN_HEX, type AgentCategory } from "../ui/theme.js";

export const P = {
  text: TOKEN_HEX.bone,
  muted: TOKEN_HEX.mist,
  dim: TOKEN_HEX.haze,
  border: TOKEN_HEX.slate,
  surface: TOKEN_HEX.ink,
  accent: TOKEN_HEX.pulse,
  info: TOKEN_HEX.sky,
  needsApproval: TOKEN_HEX.ember,
  danger: TOKEN_HEX.danger,
} as const;

/** A seat's identity colour comes from its category, never from a per-seat literal. */
export function categoryColor(category: AgentCategory): string {
  return AGENT_CATEGORY_HEX[category];
}
