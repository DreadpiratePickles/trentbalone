/**
 * The boot sequence — the web app's intro, translated (Milestone 3.2, revised).
 *
 * apps/web/components/intro.tsx types `trent`, lights the dot, then shows
 * `booting 9 agents` with each seat entering on a stagger and flipping to
 * `● ready`, all on the one easing. This file is the same rhythm in the
 * terminal, compressed so the whole thing is over well inside 1.5 seconds:
 *
 *   stage 01  the letters type in, one per 60ms
 *   stage 02  the mint dot and its glow light up
 *   stage 03  `BOOTING N AGENTS`; seat i goes `·` -> `●` at i x 70ms and
 *             `● READY` 210ms later
 *   stage 04  `N AGENTS READY`
 *   stage 05  `OPERATING`: the fading rule and the hint — the static banner
 *
 * `bootFrames` is pure and yields `{ at, lines }` so timing is testable without
 * a TTY. `playBoot` draws them, skippable on any key, wrapped in synchronized
 * output so a frame never tears. Without a TTY, or without colour, only the
 * final frame is written and no cursor moves.
 */

import type { ColorMode, TtyLike } from "./capabilities.js";
import { enterRawMode, canUseRawMode } from "./capabilities.js";
import {
  BOOT_STAGES,
  WORDMARK,
  renderBanner,
  type BannerVariant,
  type BootState,
  type SeatPhase,
} from "./banner.js";

// ── Timing ──────────────────────────────────────────────────────────────────

/** The whole sequence, first frame to last, never schedules past this. */
export const BOOT_BUDGET_MS = 1500;
/** One letter per beat while the wordmark types in. */
export const TYPE_MS = 60;
/** The dot lights this long after the last letter. */
export const DOT_AFTER_MS = 80;
/** Seats start this long after the dot. */
export const SEATS_AFTER_MS = 80;
/** The web app's stagger between seats. */
export const STAGGER_MS = 70;
/** A seat is `●` for this long before it reads READY. */
export const SEAT_READY_MS = 210;
/** From the last READY to the roster title flipping. */
export const READY_AFTER_MS = 80;
/** From READY to OPERATING — the rule and the hint. */
export const OPERATE_AFTER_MS = 120;

export interface BootFrame {
  /** Milliseconds after the first frame at which this one is due. */
  at: number;
  stage: number;
  state: BootState;
  lines: string[];
}

export interface BootOptions {
  agents: readonly string[];
  width: number;
  colorMode: ColorMode;
  variant?: BannerVariant;
}

/** The stagger that keeps N seats inside the budget; 70ms unless N is large. */
export function staggerFor(agentCount: number): number {
  if (agentCount <= 1) return STAGGER_MS;
  const fixed =
    TYPE_MS * (WORDMARK.length - 1) + DOT_AFTER_MS + SEATS_AFTER_MS + SEAT_READY_MS + READY_AFTER_MS + OPERATE_AFTER_MS;
  const room = BOOT_BUDGET_MS - fixed - 1;
  return Math.max(1, Math.min(STAGGER_MS, Math.floor(room / (agentCount - 1))));
}

export function bootFrames(opts: BootOptions): BootFrame[] {
  const variant = opts.variant ?? "repl";
  const { agents, width, colorMode } = opts;
  const frames: BootFrame[] = [];
  const base = { variant, width, colorMode };

  // stage 01: type-in
  for (let n = 1; n <= WORDMARK.length; n++) {
    frames.push({
      at: (n - 1) * TYPE_MS,
      stage: 1,
      state: "BOOTING",
      lines: renderBanner({ ...base, revealed: n, dot: false, stage: 1, state: "BOOTING", rule: false }),
    });
  }
  const dotAt = (WORDMARK.length - 1) * TYPE_MS + DOT_AFTER_MS;

  // stage 02: the dot
  frames.push({
    at: dotAt,
    stage: 2,
    state: "BOOTING",
    lines: renderBanner({ ...base, stage: 2, state: "BOOTING", rule: false }),
  });

  // stage 03: seats, on the stagger
  const seatsAt = dotAt + SEATS_AFTER_MS;
  const stagger = staggerFor(agents.length);
  const events = new Map<number, Array<{ index: number; phase: SeatPhase }>>();
  agents.forEach((_, i) => {
    const on = seatsAt + i * stagger;
    for (const [t, phase] of [[on, "booting"], [on + SEAT_READY_MS, "ready"]] as const) {
      const list = events.get(t) ?? [];
      list.push({ index: i, phase });
      events.set(t, list);
    }
  });
  const phases: SeatPhase[] = agents.map(() => "pending");
  let lastReady = seatsAt;
  if (agents.length > 0) {
    // the first event lands exactly at seatsAt, so the roster appears with seat 0 already lit
    for (const t of [...events.keys()].sort((a, b) => a - b)) {
      for (const { index, phase } of events.get(t)!) phases[index] = phase;
      frames.push({
        at: t,
        stage: 3,
        state: "BOOTING",
        lines: renderBanner({ ...base, agents, phases: [...phases], stage: 3, state: "BOOTING", rule: false }),
      });
      lastReady = t;
    }
  }

  // stage 04: ready
  const readyAt = lastReady + READY_AFTER_MS;
  frames.push({
    at: readyAt,
    stage: 4,
    state: "READY",
    lines: renderBanner({ ...base, agents, stage: 4, state: "READY", rule: false }),
  });

  // stage 05: operating — byte-identical to the static banner
  frames.push({
    at: readyAt + OPERATE_AFTER_MS,
    stage: BOOT_STAGES,
    state: "OPERATING",
    lines: renderBanner({ ...base, agents }),
  });

  return frames;
}

/** When the last frame is due. Always under the budget. */
export function bootDuration(opts: BootOptions): number {
  const frames = bootFrames(opts);
  return frames[frames.length - 1]!.at;
}

// ── Playback ────────────────────────────────────────────────────────────────

export const SYNC_BEGIN = "\x1b[?2026h";
export const SYNC_END = "\x1b[?2026l";
const CURSOR_HIDE = "\x1b[?25l";
const CURSOR_SHOW = "\x1b[?25h";
const CLEAR_LINE = "\x1b[2K";
const CLEAR_BELOW = "\x1b[0J";
const CTRL_C = "\x03";

export interface BootStdin extends TtyLike {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  resume?(): unknown;
  pause?(): unknown;
}

export interface BootIo {
  write(text: string): void;
  /** Whether stdout is a terminal. Anything else gets the final frame only. */
  isTTY: boolean;
  stdin?: BootStdin | undefined;
  /** Injectable clock, so tests can run the sequence with no real delay. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Whether the terminal understands synchronized output (DEC 2026). Defaults to true; unknown terminals ignore it harmlessly. */
  synchronized?: boolean | undefined;
}

export interface BootResult {
  /** Frames actually drawn, the final one included. */
  framesDrawn: number;
  /** A key was pressed before the sequence finished. */
  skipped: boolean;
  /** That key was Ctrl-C; the caller decides whether that means exit. */
  interrupted: boolean;
  /** No animation was attempted: not a TTY, or no colour. */
  static: boolean;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function drawFrame(io: BootIo, lines: string[], previousLines: number, sync: boolean): void {
  let out = "";
  if (sync) out += SYNC_BEGIN;
  if (previousLines > 0) out += `\x1b[${previousLines}A\r`;
  for (const line of lines) out += CLEAR_LINE + line + "\n";
  out += CLEAR_BELOW;
  if (sync) out += SYNC_END;
  io.write(out);
}

/**
 * Play the boot sequence. Returns once the final frame is on screen.
 *
 * The static path (no TTY, or colour mode `none`) writes the final frame and
 * nothing else: no cursor movement, no sync escapes, no raw mode.
 */
export async function playBoot(opts: BootOptions, io: BootIo): Promise<BootResult> {
  const frames = bootFrames(opts);
  const final = frames[frames.length - 1]!;

  if (!io.isTTY || opts.colorMode === "none") {
    io.write(final.lines.join("\n") + "\n");
    return { framesDrawn: 1, skipped: false, interrupted: false, static: true };
  }

  const sleep = io.sleep ?? defaultSleep;
  const sync = io.synchronized ?? true;
  let skipped = false;
  let interrupted = false;
  let wake: (() => void) | null = null;
  const onKey = (chunk: Buffer | string) => {
    skipped = true;
    if (String(chunk).includes(CTRL_C)) interrupted = true;
    wake?.();
  };
  const restoreRaw = io.stdin && canUseRawMode(io.stdin) ? enterRawMode(io.stdin) : () => {};
  io.stdin?.on("data", onKey);
  io.stdin?.resume?.();

  let drawn = 0;
  let previousLines = 0;
  io.write(CURSOR_HIDE);
  try {
    let elapsed = 0;
    for (const frame of frames) {
      if (skipped) break;
      const wait = frame.at - elapsed;
      if (wait > 0) {
        await Promise.race([sleep(wait), new Promise<void>((resolve) => (wake = resolve))]);
        wake = null;
        if (skipped) break;
        elapsed = frame.at;
      }
      drawFrame(io, frame.lines, previousLines, sync);
      previousLines = frame.lines.length;
      drawn++;
    }
    if (skipped) {
      drawFrame(io, final.lines, previousLines, sync);
      drawn++;
    }
  } finally {
    io.write(CURSOR_SHOW);
    io.stdin?.off("data", onKey);
    io.stdin?.pause?.();
    restoreRaw();
  }

  return { framesDrawn: drawn, skipped, interrupted, static: false };
}
