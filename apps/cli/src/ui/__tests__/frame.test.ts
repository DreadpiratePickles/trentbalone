import { describe, it, expect } from "vitest";
import { createTheme, PULSE_SGR, EMBER_SGR, sgrCodesIn } from "../theme.js";
import type { ColorMode } from "../capabilities.js";
import { hudFrame, fadingRule, pulseDot, pulseFrameAt, PULSE_PERIOD_MS, selectionBar, beveledBox, visibleWidth } from "../frame.js";

const MODES: ColorMode[] = ["none", "ansi16", "ansi256", "truecolor"];
const WIDTHS = [80, 40];

describe("width discipline", () => {
  it("no frame, rule, selection bar or beveled box line exceeds the requested width", () => {
    for (const mode of MODES) {
      const t = createTheme(mode);
      for (const w of WIDTHS) {
        const blocks: string[][] = [
          hudFrame(["Trent is thinking about a very long sentence that certainly overflows a narrow terminal window", "short"], w, t),
          [fadingRule(w, t)],
          [selectionBar("a selected row whose text is far too long to fit inside forty columns of terminal", w, t, true)],
          [selectionBar("unselected", w, t, false)],
          beveledBox(["beveled content that is also much too long for the available width by a wide margin"], w, t),
        ];
        for (const block of blocks) {
          for (const line of block) {
            expect(visibleWidth(line), `mode=${mode} w=${w} line=${JSON.stringify(line)}`).toBeLessThanOrEqual(w);
          }
        }
      }
    }
  });

  it("the hud frame fills exactly the requested width on its border rows", () => {
    const t = createTheme("none");
    for (const w of WIDTHS) {
      const lines = hudFrame(["x"], w, t);
      expect(visibleWidth(lines[0]!)).toBe(w);
      expect(visibleWidth(lines[lines.length - 1]!)).toBe(w);
    }
  });
});

describe("hud frame motif", () => {
  it("puts mint L-brackets at top-left and bottom-right only", () => {
    const t = createTheme("truecolor");
    const lines = hudFrame(["body"], 80, t);
    const topSpans = sgrCodesIn(lines[0]!);
    const bottomSpans = sgrCodesIn(lines[lines.length - 1]!);
    // the mint span opens the top row (top-left) and closes the bottom row (bottom-right)
    expect(topSpans[0]).toBe(PULSE_SGR.truecolor);
    expect(topSpans.at(-1)).not.toBe(PULSE_SGR.truecolor);
    expect(bottomSpans[0]).not.toBe(PULSE_SGR.truecolor);
    expect(bottomSpans.at(-1)).toBe(PULSE_SGR.truecolor);
    // ...and mint appears exactly twice in the whole frame: two brackets, no more
    const allMint = lines.flatMap((l) => sgrCodesIn(l)).filter((c) => c === PULSE_SGR.truecolor);
    expect(allMint).toHaveLength(2);
  });

  it("carries no ember anywhere in the chrome", () => {
    const t = createTheme("truecolor");
    for (const line of hudFrame(["body"], 80, t)) {
      expect(sgrCodesIn(line)).not.toContain(EMBER_SGR.truecolor);
    }
  });

  it("is pure box drawing with zero escapes in none mode", () => {
    expect(hudFrame(["body"], 80, createTheme("none")).join("\n")).not.toMatch(/\x1b\[/);
  });
});

describe("fading rule", () => {
  it("starts mint and decays through haze to blank", () => {
    const t = createTheme("none");
    const rule = fadingRule(60, t);
    expect(rule.trimEnd().length).toBeLessThan(60);
    expect(rule[0]).not.toBe(" ");
  });

  it("paints its head pulse and its tail not-pulse", () => {
    const t = createTheme("truecolor");
    const rule = fadingRule(60, t);
    const codes = sgrCodesIn(rule);
    expect(codes[0]).toBe(PULSE_SGR.truecolor);
    expect(codes).not.toContain(EMBER_SGR.truecolor);
    expect(new Set(codes).size).toBeGreaterThan(1);
  });
});

describe("pulse dot", () => {
  it("is a two-frame breathe over 2.4 seconds", () => {
    expect(PULSE_PERIOD_MS).toBe(2400);
    expect(pulseDot(0, createTheme("none"))).toBe("●");
    expect(pulseDot(1, createTheme("none"))).toBe("○");
    expect(pulseFrameAt(0)).toBe(0);
    expect(pulseFrameAt(1199)).toBe(0);
    expect(pulseFrameAt(1200)).toBe(1);
    expect(pulseFrameAt(2399)).toBe(1);
    expect(pulseFrameAt(2400)).toBe(0);
  });

  it("is mint, never ember", () => {
    const t = createTheme("truecolor");
    for (const f of [0, 1] as const) {
      const codes = sgrCodesIn(pulseDot(f, t));
      expect(codes).toContain(PULSE_SGR.truecolor);
      expect(codes).not.toContain(EMBER_SGR.truecolor);
    }
  });
});

describe("selection bar", () => {
  it("is a mint bar in column zero and never a full-row invert", () => {
    const t = createTheme("truecolor");
    const sel = selectionBar("row", 40, t, true);
    expect(sel).toContain("▎");
    expect(sel.indexOf("▎")).toBeLessThan(sel.indexOf("row"));
    expect(sel).not.toMatch(/\x1b\[7m/);
    expect(sgrCodesIn(sel)).toContain(PULSE_SGR.truecolor);
    expect(selectionBar("row", 40, t, false)).not.toContain("▎");
    // the unselected row keeps the same two-column gutter, so nothing shifts
    const plain = selectionBar("row", 40, createTheme("none"), false);
    expect(plain.indexOf("row")).toBe(2);
  });
});

describe("beveled box", () => {
  it("cuts the bottom-right corner", () => {
    const lines = beveledBox(["hi"], 20, createTheme("none"));
    const last = lines[lines.length - 1]!;
    expect(last.endsWith("┘")).toBe(false);
    expect(lines[0]!.endsWith("┐")).toBe(true);
  });
});

describe("no emoji in any motif", () => {
  it("holds for every mode and width", () => {
    for (const mode of MODES) {
      const t = createTheme(mode);
      for (const w of WIDTHS) {
        const out = [
          ...hudFrame(["body"], w, t),
          fadingRule(w, t),
          pulseDot(0, t),
          pulseDot(1, t),
          selectionBar("row", w, t, true),
          ...beveledBox(["body"], w, t),
        ].join("");
        expect(out).not.toMatch(/\p{Extended_Pictographic}/u);
      }
    }
  });
});
