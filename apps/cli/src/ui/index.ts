/**
 * The CLI's visual foundation. Call sites import from here and never write a
 * hex, an escape code or an emoji of their own.
 */

export {
  detectColorMode,
  isTty,
  canUseRawMode,
  enterRawMode,
  terminalWidth,
  type ColorMode,
  type ColorEnv,
  type TtyLike,
} from "./capabilities.js";

export {
  STATES,
  GLYPHS,
  GLYPH_SELECTION,
  GLYPH_DOT_HOLLOW,
  BOX,
  RULE_RAMP,
  STATE_LABEL,
  glyphFor,
  type AgentState,
} from "./glyphs.js";

export {
  createTheme,
  TOKEN_HEX,
  AGENT_CATEGORIES,
  AGENT_CATEGORY_HEX,
  STATE_TOKEN,
  PULSE_SGR,
  EMBER_SGR,
  sgrCodesIn,
  nameTokenFor,
  type Theme,
  type TokenName,
  type AgentCategory,
} from "./theme.js";

export {
  hudFrame,
  fadingRule,
  pulseDot,
  pulseFrameAt,
  PULSE_PERIOD_MS,
  selectionBar,
  beveledBox,
  visibleWidth,
  truncate,
  type PulseFrame,
} from "./frame.js";

export {
  renderBanner,
  bannerText,
  BANNER_VARIANTS,
  MAX_BANNER_WIDTH,
  type BannerVariant,
} from "./banner.js";

import { createTheme, type Theme } from "./theme.js";
import { detectColorMode } from "./capabilities.js";

/** The theme for the current process environment. */
export function autoTheme(env: NodeJS.ProcessEnv = process.env): Theme {
  return createTheme(detectColorMode(env));
}
