import { describe, it, expect } from "vitest";
import { createTheme, PULSE_SGR, EMBER_SGR, sgrCodesIn } from "../theme.js";
import type { ColorMode } from "../capabilities.js";
import { renderBanner, BANNER_VARIANTS, MAX_BANNER_WIDTH } from "../banner.js";
import { visibleWidth } from "../frame.js";

const MODES: ColorMode[] = ["none", "ansi16", "ansi256", "truecolor"];

describe("banner width", () => {
  it("never exceeds the requested width, at 80 and 40, for every variant and mode", () => {
    for (const mode of MODES) {
      const t = createTheme(mode);
      for (const w of [80, 40, 76, 30]) {
        for (const v of BANNER_VARIANTS) {
          for (const line of renderBanner(v, w, t)) {
            expect(visibleWidth(line), `${v}@${w}/${mode}: ${JSON.stringify(line)}`).toBeLessThanOrEqual(w);
          }
        }
      }
    }
  });

  it("survives an 80-column terminal: nothing is wider than 76 even when given 200", () => {
    expect(MAX_BANNER_WIDTH).toBeLessThanOrEqual(76);
    const t = createTheme("none");
    for (const v of BANNER_VARIANTS) {
      for (const line of renderBanner(v, 200, t)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(76);
      }
    }
  });

  it("degrades to a compact lockup rather than clipping the block letters at 40", () => {
    const t = createTheme("none");
    const wide = renderBanner("repl", 80, t);
    const narrow = renderBanner("repl", 40, t);
    expect(wide.some((l) => l.includes("█"))).toBe(true);
    expect(narrow.some((l) => l.includes("█"))).toBe(false);
    expect(narrow.join("\n").toLowerCase()).toContain("trent");
  });
});

describe("banner grammar", () => {
  it("renders a trailing mint dot, and never ember", () => {
    const t = createTheme("truecolor");
    for (const v of BANNER_VARIANTS) {
      const out = renderBanner(v, 80, t);
      const joined = out.join("\n");
      expect(joined).toContain("●");
      expect(sgrCodesIn(joined)).toContain(PULSE_SGR.truecolor);
      expect(sgrCodesIn(joined)).not.toContain(EMBER_SGR.truecolor);
    }
  });

  it("puts the mint dot after the wordmark, reading as trent·", () => {
    const t = createTheme("none");
    const line = renderBanner("repl", 80, t).find((l) => l.includes("●"));
    expect(line).toBeDefined();
    expect(line!.trimEnd().endsWith("●")).toBe(true);
  });

  it("emits zero escapes in none mode and still shows the wordmark", () => {
    for (const v of BANNER_VARIANTS) {
      const out = renderBanner(v, 80, createTheme("none")).join("\n");
      expect(out).not.toMatch(/\x1b\[/);
      expect(out.length).toBeGreaterThan(0);
    }
  });

  it("contains no emoji in any variant, width or mode", () => {
    for (const mode of MODES) {
      const t = createTheme(mode);
      for (const w of [80, 40]) {
        for (const v of BANNER_VARIANTS) {
          expect(renderBanner(v, w, t).join("")).not.toMatch(/\p{Extended_Pictographic}/u);
        }
      }
    }
  });

  it("uses sentence case in prose and uppercase only for the mono label", () => {
    const t = createTheme("none");
    for (const v of BANNER_VARIANTS) {
      for (const line of renderBanner(v, 80, t)) {
        const prose = line.replace(/[█▁▂▃▄▅▆▇▔─│┌┐└┘╱·●▎]/g, "").trim();
        if (!prose || prose === prose.toUpperCase()) continue;
        // any mixed-case prose line must not be Title Cased Like This
        const words = prose.split(/\s+/).filter((w) => /^[A-Za-z]+$/.test(w));
        const capitalised = words.filter((w) => /^[A-Z]/.test(w));
        expect(capitalised.length, `${v}: ${prose}`).toBeLessThanOrEqual(2);
      }
    }
  });

  it("offers a variant for repl, doctor, setup and fleet", () => {
    expect([...BANNER_VARIANTS].sort()).toEqual(["doctor", "fleet", "repl", "setup"]);
  });
});
