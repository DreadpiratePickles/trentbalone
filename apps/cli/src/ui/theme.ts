/**
 * The style module (Milestone 3.2).
 *
 * Every colour here is quoted from 01_discovery/output/design-tokens.json (core palette)
 * or the ANSI table / agent-category list in 01_discovery/output/style-contract.md.
 * No call site outside this file may write a hex or an escape code.
 *
 * The sacred colour grammar, quoted from the brand book:
 *   pulse (mint) = Trent acted autonomously. ember (copper) = a human decision is required.
 *   Never both on the same element. Never swapped. ~90% neutrals, ~8% one signal, ~2% danger.
 * State outranks identity.
 */

import type { ColorMode } from "./capabilities.js";
import { GLYPHS, STATE_LABEL, type AgentState } from "./glyphs.js";

// ── Core palette ────────────────────────────────────────────────────────────

export type TokenName =
  | "obsidian" | "ink" | "steel" | "slate" | "haze" | "mist"
  | "bone" | "bone2" | "pulse" | "ember" | "danger" | "sky";

export const TOKEN_HEX: Record<TokenName, string> = {
  obsidian: "#0A0A0F",
  ink: "#11111A",
  steel: "#1B1B26",
  slate: "#262633",
  haze: "#4A4A57",
  mist: "#94A3B8",
  bone: "#F1ECE2",
  bone2: "#E6E0D3",
  pulse: "#6EE7B7",
  ember: "#FB923C",
  danger: "#F87171",
  sky: "#7DD3FC",
};

/** 256-colour and 16-colour equivalents, straight from the style contract's ANSI table. */
const TOKEN_256: Record<TokenName, number> = {
  obsidian: 232, ink: 233, steel: 234, slate: 236, haze: 240, mist: 145,
  bone: 255, bone2: 254, pulse: 121, ember: 215, danger: 210, sky: 117,
};
const TOKEN_16: Record<TokenName, number> = {
  obsidian: 30, ink: 30, steel: 30, slate: 90, haze: 90, mist: 37,
  bone: 97, bone2: 97, pulse: 92, ember: 33, danger: 91, sky: 96,
};

// ── The 13 agent categories ─────────────────────────────────────────────────

export const AGENT_CATEGORIES = [
  "engineering", "product", "design", "marketing", "paid-media", "sales",
  "finance", "project-management", "testing", "support", "academic",
  "spatial-computing", "specialized",
] as const;
export type AgentCategory = (typeof AGENT_CATEGORIES)[number];

export const AGENT_CATEGORY_HEX: Record<AgentCategory, string> = {
  engineering: "#67E8F9",
  product: "#6EE7B7",
  design: "#F9A8D4",
  marketing: "#FB923C",
  "paid-media": "#FDBA74",
  sales: "#FDE68A",
  finance: "#A5F3D2",
  "project-management": "#A5B4FC",
  testing: "#7DD3FC",
  support: "#C4B5FD",
  academic: "#E6E0D3",
  "spatial-computing": "#5EEAD4",
  specialized: "#94A3B8",
};

const CATEGORY_256: Record<AgentCategory, number> = {
  engineering: 117, product: 121, design: 218, marketing: 215, "paid-media": 216,
  sales: 222, finance: 158, "project-management": 147, testing: 117, support: 183,
  academic: 254, "spatial-computing": 122, specialized: 145,
};
const CATEGORY_16: Record<AgentCategory, number> = {
  engineering: 96, product: 92, design: 95, marketing: 33, "paid-media": 93,
  sales: 93, finance: 92, "project-management": 94, testing: 96, support: 95,
  academic: 97, "spatial-computing": 96, specialized: 37,
};

// ── SGR construction (no chalk; we write the escapes) ───────────────────────

interface ColorSpec { hex: string; c256: number; c16: number }

function specForToken(token: TokenName): ColorSpec {
  return { hex: TOKEN_HEX[token], c256: TOKEN_256[token], c16: TOKEN_16[token] };
}
function specForCategory(category: AgentCategory): ColorSpec {
  return { hex: AGENT_CATEGORY_HEX[category], c256: CATEGORY_256[category], c16: CATEGORY_16[category] };
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function sgrFor(spec: ColorSpec, mode: ColorMode): string {
  switch (mode) {
    case "none": return "";
    case "ansi16": return String(spec.c16);
    case "ansi256": return `38;5;${spec.c256}`;
    case "truecolor": {
      const [r, g, b] = rgb(spec.hex);
      return `38;2;${r};${g};${b}`;
    }
  }
}

const RESET = "\x1b[0m";

function wrap(code: string, text: string): string {
  if (code === "") return text;
  return `\x1b[${code}m${text}${RESET}`;
}

/** All non-reset SGR parameter strings present in a rendered string. */
export function sgrCodesIn(input: string): string[] {
  const out: string[] = [];
  for (const m of input.matchAll(/\x1b\[([0-9;]*)m/g)) {
    const code = m[1] ?? "";
    if (code === "" || code === "0") continue;
    out.push(code);
  }
  return out;
}

function bySgrMode(token: TokenName): Record<ColorMode, string> {
  const spec = specForToken(token);
  return {
    none: sgrFor(spec, "none"),
    ansi16: sgrFor(spec, "ansi16"),
    ansi256: sgrFor(spec, "ansi256"),
    truecolor: sgrFor(spec, "truecolor"),
  };
}

/** The two signal colours, in every mode — used by tests to police the grammar. */
export const PULSE_SGR = bySgrMode("pulse");
export const EMBER_SGR = bySgrMode("ember");

// ── State -> signal token ───────────────────────────────────────────────────

export const STATE_TOKEN: Record<AgentState, TokenName> = {
  running: "pulse",
  needsApproval: "ember",
  done: "pulse",
  failed: "danger",
  idle: "haze",
};

/**
 * Which token an agent's *name* renders in, given its category and current state.
 *
 * State outranks identity:
 *  - awaiting a human -> ember, whatever the category is;
 *  - otherwise a category whose colour collides with a signal colour is demoted to
 *    mist, so no element ever carries two meanings at once.
 */
export function nameTokenFor(category: AgentCategory, state: AgentState): TokenName | AgentCategory {
  const signal = STATE_TOKEN[state];
  if (signal === "ember") return "ember";
  const hex = AGENT_CATEGORY_HEX[category].toUpperCase();
  if (hex === TOKEN_HEX.ember.toUpperCase()) return "mist";
  if (hex === TOKEN_HEX.pulse.toUpperCase()) return signal === "pulse" ? "pulse" : "mist";
  return category;
}

function isCategory(name: string): name is AgentCategory {
  return (AGENT_CATEGORIES as readonly string[]).includes(name);
}

// ── The theme ───────────────────────────────────────────────────────────────

export interface Theme {
  readonly mode: ColorMode;
  /** Raw SGR parameter string for a token — for renderers that compose their own spans. */
  sgr(token: TokenName): string;
  paint(token: TokenName | AgentCategory, text: string): string;

  body(text: string): string;
  meta(text: string): string;
  success(text: string): string;
  needsApproval(text: string): string;
  error(text: string): string;
  dim(text: string): string;
  emphasis(text: string): string;
  value(text: string): string;
  info(text: string): string;
  border(text: string): string;
  accent(text: string): string;

  agentName(name: string, category: AgentCategory): string;
  agentLabel(name: string, category: AgentCategory, state: AgentState): string;
  stateChip(state: AgentState): string;
  diffAdd(text: string): string;
  diffDel(text: string): string;
}

export function createTheme(mode: ColorMode): Theme {
  const codeFor = (token: TokenName | AgentCategory): string =>
    isCategory(token) ? sgrFor(specForCategory(token), mode) : sgrFor(specForToken(token), mode);

  const paint = (token: TokenName | AgentCategory, text: string): string => wrap(codeFor(token), text);

  return {
    mode,
    sgr: (token) => codeFor(token),
    paint,

    body: (t) => paint("mist", t),
    meta: (t) => paint("haze", t),
    success: (t) => paint("pulse", t),
    needsApproval: (t) => paint("ember", t),
    error: (t) => paint("danger", t),
    dim: (t) => paint("haze", t),
    emphasis: (t) => paint("bone", t),
    value: (t) => paint("bone", t),
    info: (t) => paint("sky", t),
    border: (t) => paint("slate", t),
    accent: (t) => paint("pulse", t),

    agentName: (name, category) => paint(category, name),

    agentLabel: (name, category, state) =>
      `${paint(STATE_TOKEN[state], GLYPHS[state])} ${paint(nameTokenFor(category, state), name)}`,

    stateChip: (state) => paint(STATE_TOKEN[state], `${GLYPHS[state]} ${STATE_LABEL[state]}`),

    diffAdd: (t) => paint("pulse", t),
    diffDel: (t) => paint("ember", t),
  };
}
