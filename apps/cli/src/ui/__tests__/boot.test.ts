import { describe, it, expect } from "vitest";
import {
  bootFrames,
  bootDuration,
  playBoot,
  staggerFor,
  BOOT_BUDGET_MS,
  TYPE_MS,
  DOT_AFTER_MS,
  SEATS_AFTER_MS,
  STAGGER_MS,
  SEAT_READY_MS,
  READY_AFTER_MS,
  OPERATE_AFTER_MS,
  SYNC_BEGIN,
  SYNC_END,
  type BootStdin,
} from "../boot.js";
import { renderBanner, WORDMARK } from "../banner.js";
import { visibleWidth } from "../frame.js";
import { PULSE_SGR, EMBER_SGR } from "../theme.js";

const AGENTS = ["Atlas", "Forge", "Vector", "Quill", "Echo", "Prism", "Vault", "Guard", "Pipeline"];
const CURSOR_MOVE = /\x1b\[\d*[ABCDEFGHJK]|\x1b\[\?25[hl]|\x1b\[\?2026[hl]/;
const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g;

/** The frame count the timeline implies for N seats at width >= 60. */
function expectedFrames(n: number): number {
  const stagger = staggerFor(n);
  const seatsAt = (WORDMARK.length - 1) * TYPE_MS + DOT_AFTER_MS + SEATS_AFTER_MS;
  const times = new Set<number>();
  for (let i = 0; i < n; i++) {
    times.add(seatsAt + i * stagger);
    times.add(seatsAt + i * stagger + SEAT_READY_MS);
  }
  return WORDMARK.length + 1 + times.size + 2;
}

function fakeStdin(): BootStdin & { press(key: string): void; raw: boolean[] } {
  const listeners = new Set<(chunk: Buffer | string) => void>();
  const raw: boolean[] = [];
  return {
    isTTY: true,
    raw,
    setRawMode: (mode: boolean) => raw.push(mode),
    on: (_e, l) => listeners.add(l),
    off: (_e, l) => listeners.delete(l),
    press: (key) => listeners.forEach((l) => l(key)),
  };
}

describe("the frame generator", () => {
  it("yields one frame per scheduled instant: 5 letters, the dot, every seat flip, READY, OPERATING", () => {
    for (const n of [0, 1, 3, 9, 40]) {
      const frames = bootFrames({ agents: AGENTS.slice(0, n).concat(Array(Math.max(0, n - 9)).fill("x")), width: 76, colorMode: "truecolor" });
      expect(frames.length, `${n} agents`).toBe(expectedFrames(n));
      const times = frames.map((f) => f.at);
      expect(times).toEqual([...times].sort((a, b) => a - b));
      expect(new Set(times).size, "no two frames share an instant").toBe(times.length);
    }
  });

  it("keeps the web app's 70ms stagger for nine seats and the whole sequence under 1500ms", () => {
    expect(staggerFor(9)).toBe(STAGGER_MS);
    expect(STAGGER_MS).toBe(70);
    for (const n of [0, 1, 9, 25, 100]) {
      const agents = Array.from({ length: n }, (_, i) => `agent-${i}`);
      expect(bootDuration({ agents, width: 76, colorMode: "truecolor" }), `${n} agents`).toBeLessThan(BOOT_BUDGET_MS);
    }
    expect(BOOT_BUDGET_MS).toBe(1500);
  });

  it("walks each seat pending -> booting -> READY in order, and ends with every seat READY", () => {
    const frames = bootFrames({ agents: AGENTS, width: 76, colorMode: "none" });
    const seat = (lines: string[], name: string) => lines.find((l) => l.includes(` ${name} `)) ?? "";
    for (const name of AGENTS) {
      const seen = frames.map((f) => seat(f.lines, name)).filter((l) => l !== "");
      const phase = (l: string) => (l.includes("READY") ? 2 : l.trimStart().startsWith("●") ? 1 : 0);
      const phases = seen.map(phase);
      for (let i = 1; i < phases.length; i++) expect(phases[i]).toBeGreaterThanOrEqual(phases[i - 1]!);
      expect(phases[phases.length - 1]).toBe(2);
    }
    const bootingAt = (name: string) => frames.findIndex((f) => seat(f.lines, name).trimStart().startsWith("●"));
    expect(bootingAt("Forge") - bootingAt("Atlas")).toBe(1);
    expect(frames.at(-1)!.lines.join("\n")).toContain("9 AGENTS READY");
  });

  it("counts the header up 01 -> 05 and flips BOOTING -> READY -> OPERATING", () => {
    const frames = bootFrames({ agents: AGENTS, width: 76, colorMode: "none" });
    const header = (f: (typeof frames)[number]) => f.lines.find((l) => l.startsWith("BOOT SEQUENCE"))!;
    expect(header(frames[0]!)).toBe("BOOT SEQUENCE 01 / 05 · EDITION 01 · BOOTING");
    expect(header(frames[5]!)).toBe("BOOT SEQUENCE 02 / 05 · EDITION 01 · BOOTING");
    expect(header(frames[6]!)).toBe("BOOT SEQUENCE 03 / 05 · EDITION 01 · BOOTING");
    expect(header(frames.at(-2)!)).toBe("BOOT SEQUENCE 04 / 05 · EDITION 01 · READY");
    expect(header(frames.at(-1)!)).toBe("BOOT SEQUENCE 05 / 05 · EDITION 01 · OPERATING");
    expect(frames.map((f) => f.stage)).toEqual([...frames.map((f) => f.stage)].sort((a, b) => a - b));
  });

  it("types the wordmark in one letter per frame, then lights the dot", () => {
    const frames = bootFrames({ agents: [], width: 76, colorMode: "none" });
    const blocks = (i: number) => frames[i]!.lines.slice(0, 7).join("").split("█").length;
    for (let i = 1; i < WORDMARK.length; i++) expect(blocks(i)).toBeGreaterThan(blocks(i - 1));
    for (let i = 0; i < WORDMARK.length; i++) expect(frames[i]!.lines.join("")).not.toContain("●");
    expect(frames[WORDMARK.length]!.lines.join("")).toContain("●");
    expect(frames[WORDMARK.length]!.at - frames[WORDMARK.length - 1]!.at).toBe(DOT_AFTER_MS);
    expect(READY_AFTER_MS + OPERATE_AFTER_MS).toBeGreaterThan(0);
  });

  it("ends on exactly the static banner, so the animation cannot drift from it", () => {
    for (const colorMode of ["none", "ansi16", "truecolor"] as const) {
      const frames = bootFrames({ agents: AGENTS, width: 76, colorMode });
      expect(frames.at(-1)!.lines).toEqual(renderBanner({ variant: "repl", width: 76, colorMode, agents: AGENTS }));
    }
  });

  it("keeps every frame inside the width and free of emoji, and never puts pulse and ember on one cell", () => {
    for (const width of [80, 76, 60, 40]) {
      for (const f of bootFrames({ agents: AGENTS, width, colorMode: "truecolor" })) {
        for (const line of f.lines) {
          expect(visibleWidth(line), `${width}: ${line}`).toBeLessThanOrEqual(Math.min(width, 76));
          expect(line).not.toMatch(/\p{Extended_Pictographic}/u);
          for (const m of line.matchAll(/\x1b\[([0-9;]+)m/g)) {
            const code = m[1]!;
            expect(code.includes(PULSE_SGR.truecolor) && code.includes(EMBER_SGR.truecolor)).toBe(false);
          }
        }
      }
    }
  });
});

describe("playback", () => {
  const noWait = () => Promise.resolve();

  it("writes only the final frame, with zero cursor movement, when stdout is not a TTY", async () => {
    let out = "";
    const stdin = fakeStdin();
    const result = await playBoot(
      { agents: AGENTS, width: 76, colorMode: "truecolor" },
      { write: (s) => (out += s), isTTY: false, stdin, sleep: noWait },
    );
    expect(result).toEqual({ framesDrawn: 1, skipped: false, interrupted: false, static: true });
    expect(out).not.toMatch(CURSOR_MOVE);
    expect(out).toBe(renderBanner({ variant: "repl", width: 76, colorMode: "truecolor", agents: AGENTS }).join("\n") + "\n");
    expect(stdin.raw).toEqual([]);
  });

  it("writes only the final frame, with no escapes at all, under NO_COLOR", async () => {
    let out = "";
    const result = await playBoot(
      { agents: AGENTS, width: 76, colorMode: "none" },
      { write: (s) => (out += s), isTTY: true, stdin: fakeStdin(), sleep: noWait },
    );
    expect(result.static).toBe(true);
    expect(out).not.toMatch(/\x1b/);
    expect(out).toBe(renderBanner({ variant: "repl", width: 76, colorMode: "none", agents: AGENTS }).join("\n") + "\n");
  });

  it("draws every frame on a TTY, each wrapped in synchronized output, and restores the cursor and raw mode", async () => {
    let out = "";
    const stdin = fakeStdin();
    const waits: number[] = [];
    const frames = bootFrames({ agents: AGENTS, width: 76, colorMode: "truecolor" });
    const result = await playBoot(
      { agents: AGENTS, width: 76, colorMode: "truecolor" },
      { write: (s) => (out += s), isTTY: true, stdin, sleep: async (ms) => void waits.push(ms) },
    );
    expect(result).toEqual({ framesDrawn: frames.length, skipped: false, interrupted: false, static: false });
    expect(out.split(SYNC_BEGIN).length - 1).toBe(frames.length);
    expect(out.split(SYNC_END).length - 1).toBe(frames.length);
    expect(waits.reduce((a, b) => a + b, 0)).toBe(frames.at(-1)!.at);
    expect(waits.every((w) => w > 0)).toBe(true);
    expect(out.startsWith("\x1b[?25l")).toBe(true);
    expect(out.endsWith("\x1b[?25h")).toBe(true);
    expect(stdin.raw).toEqual([true, false]);
    // the screen ends on the static banner
    const last = out.slice(out.lastIndexOf(SYNC_BEGIN), out.lastIndexOf(SYNC_END));
    const plain = last.replace(ANSI, "").replace(/\r/g, "");
    expect(plain.trimEnd()).toBe(
      renderBanner({ variant: "repl", width: 76, colorMode: "truecolor", agents: AGENTS }).map((l) => l.replace(ANSI, "")).join("\n"),
    );
  });

  it("skips to the final frame on any key, and reports Ctrl-C as an interrupt", async () => {
    for (const [key, interrupted] of [["x", false], ["\x03", true]] as const) {
      let out = "";
      const stdin = fakeStdin();
      let slept = 0;
      const result = await playBoot(
        { agents: AGENTS, width: 76, colorMode: "truecolor" },
        {
          write: (s) => (out += s),
          isTTY: true,
          stdin,
          sleep: () =>
            new Promise((resolve) => {
              if (++slept === 3) stdin.press(key);
              setTimeout(resolve, 5);
            }),
        },
      );
      expect(result.skipped).toBe(true);
      expect(result.interrupted).toBe(interrupted);
      expect(result.framesDrawn).toBeLessThan(bootFrames({ agents: AGENTS, width: 76, colorMode: "truecolor" }).length);
      expect(out.replace(ANSI, "")).toContain("9 AGENTS READY");
      expect(out.endsWith("\x1b[?25h")).toBe(true);
      expect(stdin.raw).toEqual([true, false]);
    }
  });
});
