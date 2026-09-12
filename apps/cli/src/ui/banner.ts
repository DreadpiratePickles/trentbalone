/**
 * The wordmark (Milestone 3.2).
 *
 * There are zero image assets in the repo. The logo is pure CSS in
 * apps/web/components/ui/index.tsx: lowercase Inter Black `trent` at -0.06em
 * tracking followed by a glowing mint dot — read it as `trent.`.
 *
 * The terminal translation, per the style contract: block-letter TRENT in bone
 * with a trailing mint dot. Everything stays at or under 76 columns so the
 * banner survives an 80-column terminal with room to spare.
 */

import { fadingRule, truncate, visibleWidth } from "./frame.js";
import { GLYPHS } from "./glyphs.js";
import type { Theme } from "./theme.js";

export const BANNER_VARIANTS = ["repl", "doctor", "setup", "fleet"] as const;
export type BannerVariant = (typeof BANNER_VARIANTS)[number];

/** Hard ceiling: an 80-column terminal keeps a 4-column gutter. */
export const MAX_BANNER_WIDTH = 76;

/** 7x5 block letters. Inter Black is a heavy face; these are its terminal stand-in. */
const LETTERS: Record<string, readonly string[]> = {
  T: ["███████", "  ███  ", "  ███  ", "  ███  ", "  ███  "],
  R: ["██████ ", "██   ██", "██████ ", "██  ██ ", "██   ██"],
  E: ["███████", "██     ", "██████ ", "██     ", "███████"],
  N: ["██   ██", "███  ██", "██ █ ██", "██  ███", "██   ██"],
};

const WORDMARK = "TRENT";
const BLOCK_ROWS = 5;
/** 5 letters of 7 columns with 1-column gaps, plus a space and the mint dot. */
const BLOCK_WIDTH = WORDMARK.length * 7 + (WORDMARK.length - 1) + 2;

interface VariantSpec {
  label: string;
  subtitle: string;
  hint: string;
  block: boolean;
}

const SPECS: Record<BannerVariant, VariantSpec> = {
  repl: {
    label: "REPL",
    subtitle: "your cofounder, in the terminal",
    hint: "CTRL-J NEWLINE    CTRL-C INTERRUPT",
    block: true,
  },
  setup: {
    label: "SETUP",
    subtitle: "let's get you connected",
    hint: "NOTHING IS WRITTEN UNTIL YOU CONFIRM",
    block: true,
  },
  doctor: {
    label: "DOCTOR",
    subtitle: "checking your environment",
    hint: "READ ONLY    NO CHANGES ARE MADE",
    block: false,
  },
  fleet: {
    label: "FLEET",
    subtitle: "164 specialists, one conversation",
    hint: "ARROWS TO MOVE    ENTER TO OPEN",
    block: false,
  },
};

function blockLines(theme: Theme): string[] {
  const rows: string[] = [];
  for (let r = 0; r < BLOCK_ROWS; r++) {
    const row = Array.from(WORDMARK)
      .map((ch) => LETTERS[ch]![r]!)
      .join(" ")
      .replace(/\s+$/, "");
    rows.push(theme.emphasis(row));
  }
  // The mint dot rides the baseline of the last row, exactly as the CSS wordmark does.
  rows[BLOCK_ROWS - 1] += " " + theme.accent(GLYPHS.running);
  return rows;
}

function compactLockup(label: string, theme: Theme): string {
  return theme.emphasis(WORDMARK) + " " + theme.accent(GLYPHS.running) + "   " + theme.meta(label);
}

export function renderBanner(variant: BannerVariant, width: number, theme: Theme): string[] {
  const spec = SPECS[variant];
  const w = Math.max(12, Math.min(Math.floor(width), MAX_BANNER_WIDTH));
  const out: string[] = [];

  const useBlock = spec.block && w >= BLOCK_WIDTH;

  if (useBlock) {
    out.push(...blockLines(theme));
    out.push("");
  } else {
    out.push(compactLockup(spec.label, theme));
  }

  const subtitle = truncate(spec.subtitle, w);
  if (subtitle.length > 0) out.push(theme.body(subtitle));

  out.push(fadingRule(w, theme));

  // The block form has no lockup label, so the label leads the mono hint line.
  const hintSource = useBlock ? `${spec.label}    ${spec.hint}` : spec.hint;
  const hint = truncate(hintSource, w);
  if (visibleWidth(hint) >= 8) out.push(theme.meta(hint));

  return out;
}

/** Convenience for call sites that want a single printable string. */
export function bannerText(variant: BannerVariant, width: number, theme: Theme): string {
  return renderBanner(variant, width, theme).join("\n");
}
