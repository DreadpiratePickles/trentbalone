/**
 * Terminal capability detection (Milestone 3.1).
 *
 * Detection order is fixed by 01_discovery/output/style-contract.md:
 *   NO_COLOR -> none; COLORTERM=truecolor|24bit -> truecolor;
 *   TERM=*-256color -> ansi256; else ansi16.
 * `TERM=dumb` is additionally treated as `none` — a dumb terminal cannot render SGR at all.
 */

export type ColorMode = "none" | "ansi16" | "ansi256" | "truecolor";

/** Minimal shape of the env we read. Injectable so tests never mutate process.env. */
export interface ColorEnv {
  NO_COLOR?: string | undefined;
  COLORTERM?: string | undefined;
  TERM?: string | undefined;
}

/** Minimal shape of a stream we probe. */
export interface TtyLike {
  isTTY?: boolean | undefined;
  setRawMode?: ((mode: boolean) => unknown) | undefined;
}

export function detectColorMode(env: ColorEnv = process.env): ColorMode {
  // NO_COLOR is honoured when *present and non-empty* (the no-color.org convention).
  if (typeof env.NO_COLOR === "string" && env.NO_COLOR.length > 0) return "none";

  const term = (env.TERM ?? "").toLowerCase();
  if (term === "dumb") return "none";

  const colorterm = (env.COLORTERM ?? "").toLowerCase();
  if (colorterm === "truecolor" || colorterm === "24bit") return "truecolor";

  if (/-256color(\b|$)/.test(term)) return "ansi256";

  return "ansi16";
}

export function isTty(stream: TtyLike | undefined = process.stdout): boolean {
  return Boolean(stream && stream.isTTY === true);
}

/**
 * Raw mode is only available on a tty that actually exposes setRawMode.
 * A piped stdin has no setRawMode; calling it throws. Every raw-mode call site
 * must gate on this.
 */
export function canUseRawMode(stream: TtyLike | undefined = process.stdin): boolean {
  return isTty(stream) && typeof stream?.setRawMode === "function";
}

/** Enter raw mode if — and only if — it is safe to. Returns a restore function. */
export function enterRawMode(stream: TtyLike | undefined = process.stdin): () => void {
  if (!canUseRawMode(stream)) return () => {};
  stream!.setRawMode!(true);
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    try {
      stream!.setRawMode!(false);
    } catch {
      /* the stream may already be closed; never let cleanup throw */
    }
  };
}

/** Usable terminal width, clamped to something a renderer can survive. */
export function terminalWidth(stream: { columns?: number } | undefined = process.stdout): number {
  const cols = stream?.columns;
  if (typeof cols !== "number" || !Number.isFinite(cols) || cols <= 0) return 80;
  return Math.max(20, Math.floor(cols));
}
