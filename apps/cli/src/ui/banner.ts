/**
 * The wordmark and the banner (Milestone 3.2, revised).
 *
 * There are zero image assets in the repo. The logo is pure CSS in
 * apps/web/components/ui/index.tsx: lowercase Inter Black `trent` at -0.06em
 * tracking followed by a glowing mint dot — read it as `trent·`. Loaded in a
 * browser the app shows a boot sequence: the wordmark over an atmosphere grid,
 * a tracked mono header, then `BOOTING 9 AGENTS` flipping each seat to READY.
 *
 * This file is the terminal translation of that first screen, as a pure
 * function of (variant, width, colour mode, agents) so it is testable without a
 * TTY. `boot.ts` animates it; the installer `cat`s a pre-rendered copy.
 *
 * Composition is layered onto a cell grid, lowest first:
 *   1. the atmosphere lattice   `·` in haze, mint-tinted top-left, ember-tinted
 *                               bottom-right (the web app's .atmos-glow);
 *   2. the dot's glow           `·` in pulse then haze, concentric around `●`;
 *   3. the extrusion            the letters shifted one cell right and one cell
 *                               down, in haze, so the mark stands off the grid;
 *   4. the letters              10px-tall bitmaps rendered two pixels per row
 *                               with half blocks, in bone; the mint `●` last.
 * Every cell carries exactly one colour, so pulse and ember can never share one.
 */

import type { ColorMode } from "./capabilities.js";
import { fadingRule, truncate, visibleWidth } from "./frame.js";
import { GLYPHS } from "./glyphs.js";
import { createTheme, type Theme, type TokenName } from "./theme.js";

export const BANNER_VARIANTS = ["repl", "doctor", "setup", "fleet", "installer"] as const;
export type BannerVariant = (typeof BANNER_VARIANTS)[number];

/** Hard ceiling: an 80-column terminal keeps a 4-column gutter. */
export const MAX_BANNER_WIDTH = 76;
/** Below this the block wordmark gives way to the compact lockup. */
export const COMPACT_BELOW_WIDTH = 60;

export const WORDMARK = "TRENT";
export const BOOT_STAGES = 5;
export const EDITION = "01";

// ── Letterforms ─────────────────────────────────────────────────────────────
// 7 pixels wide, 10 tall; `#` is ink. Heavy strokes stand in for Inter Black.
// Two pixel rows become one terminal row of ▀ ▄ █, so the mark is 5 rows tall
// but drawn at twice the vertical resolution of a plain block font.

const PX: Record<string, readonly string[]> = {
  T: ["#######", "#######", "  ###  ", "  ###  ", "  ###  ", "  ###  ", "  ###  ", "  ###  ", "  ###  ", "  ###  "],
  R: ["###### ", "#######", "###  ##", "###  ##", "###### ", "###### ", "### ## ", "###  ##", "###  ##", "###  ##"],
  E: ["#######", "#######", "###    ", "###    ", "###### ", "###### ", "###    ", "###    ", "#######", "#######"],
  N: ["###  ##", "###  ##", "#### ##", "#### ##", "### ###", "### ###", "## ####", "## ####", "##  ###", "##  ###"],
};

const PX_W = 7;
const PX_H = 10;
const LETTER_GAP = 2;
const MARK_ROWS = PX_H / 2;
/** Letters, gaps, one column of extrusion, a breath, then the glow field. */
const GLOW_RADIUS = 2;
const LETTERS_W = WORDMARK.length * PX_W + (WORDMARK.length - 1) * LETTER_GAP + 1;
const DOT_COL = LETTERS_W + 2 + GLOW_RADIUS;
export const MARK_WIDTH = DOT_COL + GLOW_RADIUS + 1;

/** Lattice pitch. 64px on a ~8x16px cell is 8x4; halved so it reads at 76 columns. */
const LATTICE_COLS = 6;
const LATTICE_ROWS = 2;

type Cell = { glyph: string; token: TokenName } | null;

function letterPixel(col: number, px: number, revealed: number): boolean {
  if (col < 0 || px < 0 || px >= PX_H) return false;
  const pitch = PX_W + LETTER_GAP;
  const index = Math.floor(col / pitch);
  if (index >= revealed || index >= WORDMARK.length) return false;
  const x = col - index * pitch;
  if (x >= PX_W) return false;
  return PX[WORDMARK[index]!]![px]![x] === "#";
}

function halfBlock(top: boolean, bottom: boolean): string {
  if (top && bottom) return "█";
  if (top) return "▀";
  return "▄";
}

export interface WordmarkOptions {
  width: number;
  /** How many letters are drawn (0..5). Drives the type-in beat of the boot. */
  revealed?: number;
  /** Whether the mint dot and its glow are drawn. */
  dot?: boolean;
  /** Whether the atmosphere lattice is drawn behind the mark. */
  atmosphere?: boolean;
  /** Vertical extent of the field: extra empty (lattice-only) rows above and below. */
  margin?: number;
  /** Whether the haze extrusion is drawn. Off in monochrome, where it would blur the mark. */
  extrude?: boolean;
}

/**
 * The wordmark as a grid of cells, `width` wide. Rows outside the letters are
 * lattice only. Pure; the theme is applied by `paintGrid`.
 */
export function composeWordmark(opts: WordmarkOptions): Cell[][] {
  const width = Math.max(MARK_WIDTH, Math.floor(opts.width));
  const revealed = Math.max(0, Math.min(WORDMARK.length, opts.revealed ?? WORDMARK.length));
  const dot = opts.dot ?? true;
  const atmosphere = opts.atmosphere ?? true;
  const margin = Math.max(0, opts.margin ?? 1);
  const rows = MARK_ROWS + margin * 2;
  const left = Math.floor((width - MARK_WIDTH) / 2);
  const dotRow = margin + MARK_ROWS - 1;
  const dotCol = left + DOT_COL;

  const grid: Cell[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < width; c++) row.push(null);
    grid.push(row);
  }

  // 1. atmosphere lattice with the two corner tints
  if (atmosphere) {
    for (let r = 0; r < rows; r += LATTICE_ROWS) {
      for (let c = LATTICE_COLS / 2; c < width; c += LATTICE_COLS) {
        const mint = r === 0 && c < width * 0.22;
        const ember = r === rows - 1 && c > width * 0.85;
        const token: TokenName = mint ? "pulse" : ember ? "ember" : "haze";
        const onPlate = r >= margin && r <= margin + MARK_ROWS && c >= left - 1 && c <= left + MARK_WIDTH;
        if (!onPlate) grid[r]![c] = { glyph: GLYPHS.idle, token };
      }
    }
  }

  // 2. the glow: concentric dim mint cells around the dot
  if (dot && revealed === WORDMARK.length) {
    for (let dr = -GLOW_RADIUS; dr <= GLOW_RADIUS; dr++) {
      for (let dc = -GLOW_RADIUS; dc <= GLOW_RADIUS; dc++) {
        const r = dotRow + dr;
        const c = dotCol + dc;
        if (r < 0 || r >= rows || c < 0 || c >= width) continue;
        const dist = Math.max(Math.abs(dr), Math.abs(dc));
        if (dist === 0) grid[r]![c] = { glyph: GLYPHS.running, token: "pulse" };
        else if (dist === 1) grid[r]![c] = { glyph: GLYPHS.idle, token: "pulse" };
        else if (dr === 0 || dc === 0) grid[r]![c] = { glyph: GLYPHS.idle, token: "haze" };
      }
    }
  }

  // 3 + 4. the extrusion — the letters one cell right and one cell down, in haze —
  // then the letters themselves. Monochrome has no haze, so it gets no extrusion:
  // a shape it cannot tell from the letter would only blur the mark.
  const extrude = opts.extrude ?? true;
  for (let r = 0; r < MARK_ROWS + 1; r++) {
    const row = grid[r + margin];
    if (row === undefined) continue;
    for (let c = 0; c < LETTERS_W; c++) {
      const topPx = r * 2;
      const lt = letterPixel(c, topPx, revealed);
      const lb = letterPixel(c, topPx + 1, revealed);
      const st = extrude && letterPixel(c - 1, topPx - 2, revealed);
      const sb = extrude && letterPixel(c - 1, topPx - 1, revealed);
      if (lt || lb) row[left + c] = { glyph: halfBlock(lt, lb), token: "bone" };
      else if (st || sb) row[left + c] = { glyph: halfBlock(st, sb), token: "haze" };
    }
  }

  return grid;
}

/** Paint a cell grid into lines, merging runs of one token into one SGR span. */
export function paintGrid(grid: Cell[][], theme: Theme): string[] {
  return grid.map((row) => {
    let out = "";
    let run = "";
    let runToken: TokenName | null = null;
    const flush = () => {
      if (run.length === 0) return;
      out += runToken === null ? run : theme.paint(runToken, run);
      run = "";
    };
    for (const cell of row) {
      const token = cell?.token ?? null;
      if (token !== runToken) {
        flush();
        runToken = token;
      }
      run += cell?.glyph ?? " ";
    }
    flush();
    return out.replace(/ +$/, "");
  });
}

export function renderWordmark(opts: WordmarkOptions, theme: Theme): string[] {
  return paintGrid(composeWordmark(opts), theme);
}

// ── Variants ────────────────────────────────────────────────────────────────

interface VariantSpec {
  label: string;
  subtitle: string;
  hint: string;
  full: boolean;
}

const SPECS: Record<BannerVariant, VariantSpec> = {
  repl: {
    label: "REPL",
    subtitle: "your cofounder, in the terminal",
    hint: "CTRL-J NEWLINE    CTRL-C INTERRUPT",
    full: true,
  },
  setup: {
    label: "SETUP",
    subtitle: "let's get you connected",
    hint: "NOTHING IS WRITTEN UNTIL YOU CONFIRM",
    full: true,
  },
  installer: {
    label: "INSTALL",
    subtitle: "the cofounder who never sleeps",
    hint: "VERIFIED SHA-256    INSTALLED TO YOUR HOME",
    full: true,
  },
  doctor: {
    label: "DOCTOR",
    subtitle: "checking your environment",
    hint: "READ ONLY    NO CHANGES ARE MADE",
    full: false,
  },
  fleet: {
    label: "FLEET",
    subtitle: "164 specialists, one conversation",
    hint: "ARROWS TO MOVE    ENTER TO OPEN",
    full: false,
  },
};

export type BootState = "BOOTING" | "READY" | "OPERATING";

/** The tracked mono header: `BOOT SEQUENCE 03 / 05 · EDITION 01 · OPERATING`. */
export function renderHeader(stage: number, state: BootState, width: number, theme: Theme): string {
  const n = String(Math.max(1, Math.min(BOOT_STAGES, stage))).padStart(2, "0");
  const of = String(BOOT_STAGES).padStart(2, "0");
  const sep = theme.accent(GLYPHS.idle);
  const parts =
    width >= COMPACT_BELOW_WIDTH
      ? [`BOOT SEQUENCE ${n} / ${of}`, `EDITION ${EDITION}`, state]
      : [`BOOT ${n}/${of}`, state];
  const plain = parts.join(" · ");
  if (plain.length > width) return theme.meta(truncate(plain, width));
  return parts.map((p) => theme.meta(p)).join(` ${sep} `);
}

export function compactLockup(label: string, theme: Theme): string {
  return theme.emphasis(WORDMARK) + " " + theme.accent(GLYPHS.running) + "   " + theme.meta(label);
}

// ── The agent roster ────────────────────────────────────────────────────────

export type SeatPhase = "pending" | "booting" | "ready";

const SEAT_NAME_W = 14;
const SEAT_W = 2 + SEAT_NAME_W + 1 + 5; // "● " + name + " " + "READY"
const SEAT_GAP = 3;

function seat(name: string, phase: SeatPhase, theme: Theme): string {
  const label = truncate(name, SEAT_NAME_W).padEnd(SEAT_NAME_W);
  switch (phase) {
    case "pending":
      return theme.dim(GLYPHS.idle) + " " + theme.dim(label) + " " + " ".repeat(5);
    case "booting":
      return theme.accent(GLYPHS.running) + " " + theme.emphasis(label) + " " + theme.dim("·····");
    case "ready":
      return theme.accent(GLYPHS.running) + " " + theme.emphasis(label) + " " + theme.accent("READY");
  }
}

/** How many seat columns fit: three at 76, two at 60, one below. */
export function rosterColumns(width: number): number {
  return Math.max(1, Math.floor((width + SEAT_GAP) / (SEAT_W + SEAT_GAP)));
}

/**
 * `BOOTING N AGENTS` and the grid of seats. `phases[i]` is the phase of `agents[i]`;
 * a missing entry is `ready`, so the static banner shows the final frame.
 */
export function renderRoster(
  agents: readonly string[],
  width: number,
  theme: Theme,
  phases: readonly SeatPhase[] = [],
): string[] {
  if (agents.length === 0) return [];
  const w = Math.max(12, Math.min(Math.floor(width), MAX_BANNER_WIDTH));
  const readyCount = agents.filter((_, i) => (phases[i] ?? "ready") === "ready").length;
  const title =
    readyCount === agents.length
      ? `${agents.length} AGENTS READY`
      : `BOOTING ${agents.length} AGENT${agents.length === 1 ? "" : "S"}`;
  const out = [theme.accent(GLYPHS.running) + " " + theme.body(truncate(title, w - 2))];
  const cols = rosterColumns(w);
  const rows = Math.ceil(agents.length / cols);
  for (let r = 0; r < rows; r++) {
    const cells: string[] = [];
    for (let c = 0; c < cols; c++) {
      const i = c * rows + r;
      if (i < agents.length) cells.push(seat(agents[i]!, phases[i] ?? "ready", theme));
    }
    out.push(cells.join(" ".repeat(SEAT_GAP)).replace(/ +$/, ""));
  }
  return out;
}

// ── The banner ──────────────────────────────────────────────────────────────

export interface BannerOptions {
  variant: BannerVariant;
  width: number;
  colorMode: ColorMode;
  /** Configured agents (fleet.installed_agents). Full variants list them as READY. */
  agents?: readonly string[];
  /** Header stage and state; the static banner is the final frame of the boot. */
  stage?: number;
  state?: BootState;
  /** Letters revealed, for the type-in beat. Defaults to all. */
  revealed?: number;
  /** Whether the mint dot is lit. Defaults to true. */
  dot?: boolean;
  /** Whether the fading rule and the hint are drawn. Defaults to true. */
  rule?: boolean;
  /** Seat phases for the roster, for the booting beat. Defaults to all ready. */
  phases?: readonly SeatPhase[];
}

function clampWidth(width: number): number {
  return Math.max(12, Math.min(Math.floor(width), MAX_BANNER_WIDTH));
}

function renderFromOptions(o: BannerOptions): string[] {
  const theme = createTheme(o.colorMode);
  const spec = SPECS[o.variant];
  const w = clampWidth(o.width);
  const useBlock = spec.full && w >= COMPACT_BELOW_WIDTH && w >= MARK_WIDTH;
  const out: string[] = [];

  if (useBlock) {
    out.push(
      ...renderWordmark(
        { width: w, revealed: o.revealed ?? WORDMARK.length, dot: o.dot ?? true, extrude: theme.mode !== "none" },
        theme,
      ),
    );
    out.push(renderHeader(o.stage ?? BOOT_STAGES, o.state ?? "OPERATING", w, theme));
  } else {
    out.push(compactLockup(spec.label, theme));
  }

  const subtitle = truncate(spec.subtitle, w);
  if (subtitle.length > 0) out.push(theme.body(subtitle));

  if (spec.full && o.agents && o.agents.length > 0) {
    out.push("");
    out.push(...renderRoster(o.agents, w, theme, o.phases ?? []));
  }

  if (o.rule === false) return out;
  out.push(fadingRule(w, theme));

  // The block form has no lockup label, so the label leads the mono hint line.
  const hintSource = useBlock ? `${spec.label}    ${spec.hint}` : spec.hint;
  const hint = truncate(hintSource, w);
  if (visibleWidth(hint) >= 8) out.push(theme.meta(hint));

  return out;
}

/**
 * Pure: (variant, width, colour mode, agents) -> lines. No line is wider than
 * `width`, and never wider than 76. Below 60 columns the compact lockup is used.
 * The positional form is kept for the call sites that already hold a theme.
 */
export function renderBanner(options: BannerOptions): string[];
export function renderBanner(variant: BannerVariant, width: number, theme: Theme): string[];
export function renderBanner(a: BannerOptions | BannerVariant, width?: number, theme?: Theme): string[] {
  if (typeof a === "string") {
    return renderFromOptions({ variant: a, width: width ?? MAX_BANNER_WIDTH, colorMode: theme?.mode ?? "none" });
  }
  return renderFromOptions(a);
}

/** Convenience for call sites that want a single printable string. */
export function bannerText(options: BannerOptions): string;
export function bannerText(variant: BannerVariant, width: number, theme: Theme): string;
export function bannerText(a: BannerOptions | BannerVariant, width?: number, theme?: Theme): string {
  return (typeof a === "string" ? renderBanner(a, width!, theme!) : renderBanner(a)).join("\n");
}

/**
 * The installer's pre-rendered banner: exactly what `scripts/installer/banner.ansi`
 * (truecolor) and `banner-16.ansi` (16-colour) must contain, byte for byte, so
 * the shell script can `cat` it and the files cannot drift from this source.
 */
export function installerBannerBytes(colorMode: ColorMode): string {
  return renderBanner({ variant: "installer", width: MAX_BANNER_WIDTH, colorMode }).join("\n") + "\n";
}
