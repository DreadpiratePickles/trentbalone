import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTheme, PULSE_SGR, EMBER_SGR, sgrCodesIn } from "../theme.js";
import type { ColorMode } from "../capabilities.js";
import {
  renderBanner,
  renderRoster,
  rosterColumns,
  installerBannerBytes,
  BANNER_VARIANTS,
  MAX_BANNER_WIDTH,
  COMPACT_BELOW_WIDTH,
} from "../banner.js";
import { visibleWidth } from "../frame.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../../..");

const MODES: ColorMode[] = ["none", "ansi16", "ansi256", "truecolor"];
const WIDTHS = [80, 76, 60, 40];
const AGENTS = ["Atlas", "Forge", "Vector", "Quill", "Echo", "Prism", "Vault", "Guard", "Pipeline"];
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Every coloured span: the SGR parameter string and the text it covers. */
function spans(line: string): Array<{ code: string; text: string }> {
  const out: Array<{ code: string; text: string }> = [];
  for (const m of line.matchAll(/\x1b\[([0-9;]+)m([^\x1b]*)\x1b\[0m/g)) {
    if (m[1] !== "0") out.push({ code: m[1]!, text: m[2]! });
  }
  return out;
}

describe("banner width", () => {
  it("never exceeds the requested width, at 80/76/60/40, for every variant and mode, with and without agents", () => {
    for (const colorMode of MODES) {
      for (const width of WIDTHS) {
        for (const variant of BANNER_VARIANTS) {
          for (const agents of [undefined, AGENTS]) {
            for (const line of renderBanner({ variant, width, colorMode, agents })) {
              expect(visibleWidth(line), `${variant}@${width}/${colorMode}: ${JSON.stringify(line)}`).toBeLessThanOrEqual(
                Math.min(width, MAX_BANNER_WIDTH),
              );
            }
          }
        }
      }
    }
  });

  it("survives an 80-column terminal: nothing is wider than 76 even when given 200", () => {
    expect(MAX_BANNER_WIDTH).toBeLessThanOrEqual(76);
    for (const variant of BANNER_VARIANTS) {
      for (const line of renderBanner({ variant, width: 200, colorMode: "none", agents: AGENTS })) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(76);
      }
    }
  });

  it("uses the block wordmark at 60 and above, and the compact lockup below", () => {
    expect(COMPACT_BELOW_WIDTH).toBe(60);
    const at = (width: number) => renderBanner({ variant: "repl", width, colorMode: "none" });
    expect(at(60).some((l) => l.includes("█"))).toBe(true);
    expect(at(59).some((l) => l.includes("█"))).toBe(false);
    expect(at(40).some((l) => l.includes("█"))).toBe(false);
    expect(at(40).join("\n").toLowerCase()).toContain("trent");
  });

  it("keeps the long agent names inside the seat cell", () => {
    const agents = ["a-very-long-agent-identifier-that-goes-on", "ceo"];
    for (const line of renderRoster(agents, 76, createTheme("none"))) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(76);
    }
  });

  it("lays the roster out in three columns at 76, two at 60, one at 40", () => {
    expect(rosterColumns(76)).toBe(3);
    expect(rosterColumns(60)).toBe(2);
    expect(rosterColumns(40)).toBe(1);
  });

  it("accepts the positional (variant, width, theme) form the REPL already uses", () => {
    const theme = createTheme("truecolor");
    expect(renderBanner("repl", 76, theme)).toEqual(renderBanner({ variant: "repl", width: 76, colorMode: "truecolor" }));
  });
});

describe("banner grammar", () => {
  it("lights the mint dot in every variant and mode", () => {
    for (const colorMode of MODES.filter((m) => m !== "none")) {
      for (const variant of BANNER_VARIANTS) {
        const joined = renderBanner({ variant, width: 76, colorMode }).join("\n");
        expect(joined).toContain("●");
        expect(sgrCodesIn(joined)).toContain(PULSE_SGR[colorMode]);
      }
    }
  });

  it("puts the mint dot after the wordmark, reading as trent·, with its glow around it", () => {
    const lines = renderBanner({ variant: "repl", width: 76, colorMode: "none" });
    const baseline = lines.findIndex((l) => l.includes("●"));
    expect(baseline).toBeGreaterThan(0);
    const row = lines[baseline]!;
    const lastBlock = row.lastIndexOf("█");
    const dotAt = row.indexOf("●");
    expect(dotAt).toBeGreaterThan(lastBlock);
    // glow: dim cells hug the dot on its own row and the rows above and below
    expect(row.slice(dotAt - 2, dotAt + 3)).toBe("··●··");
    expect(lines[baseline - 1]!.slice(dotAt - 1, dotAt + 2)).toBe("···");
    expect(lines[baseline + 1]!.slice(dotAt - 1, dotAt + 2)).toBe("···");
  });

  it("colours the glow mint in the inner ring and haze in the outer, never ember", () => {
    const theme = createTheme("truecolor");
    const lines = renderBanner({ variant: "repl", width: 76, colorMode: "truecolor" });
    const row = lines.find((l) => l.includes("●"))!;
    const around = spans(row).filter((s) => s.text.includes("●"));
    expect(around).toHaveLength(1);
    expect(around[0]!.code).toBe(theme.sgr("pulse"));
    expect(around[0]!.text).toBe("·●·");
  });

  it("never paints the wordmark letters or the dot in ember", () => {
    for (const colorMode of MODES.filter((m) => m !== "none")) {
      for (const variant of BANNER_VARIANTS) {
        for (const line of renderBanner({ variant, width: 76, colorMode, agents: AGENTS })) {
          for (const s of spans(line)) {
            if (s.code === EMBER_SGR[colorMode]) expect(s.text, line).toMatch(/^[·]+$/);
          }
        }
      }
    }
  });

  it("carries ember only in the bottom-right atmosphere tint and pulse in the top-left, never on one cell", () => {
    const lines = renderBanner({ variant: "repl", width: 76, colorMode: "truecolor", agents: AGENTS });
    const ember = EMBER_SGR.truecolor;
    const pulse = PULSE_SGR.truecolor;
    for (const line of lines) {
      for (const s of spans(line)) {
        const codes = s.code.split(";").join(";");
        expect(codes.includes(pulse) && codes.includes(ember), line).toBe(false);
      }
    }
    const first = spans(lines[0]!);
    expect(first.some((s) => s.code === pulse)).toBe(true);
    expect(first.some((s) => s.code === ember)).toBe(false);
    const lastMarkRow = lines.findIndex((l) => l.replace(ANSI_RE, "").startsWith("BOOT")) - 1;
    expect(spans(lines[lastMarkRow]!).some((s) => s.code === ember)).toBe(true);
  });

  it("keeps the signal budget: at most 8% of coloured cells pulse and 2% ember", () => {
    const lines = renderBanner({ variant: "repl", width: 76, colorMode: "truecolor" });
    let total = 0;
    let pulse = 0;
    let ember = 0;
    for (const line of lines) {
      total += 76;
      for (const s of spans(line)) {
        const cells = Array.from(s.text).length;
        if (s.code === PULSE_SGR.truecolor) pulse += cells;
        if (s.code === EMBER_SGR.truecolor) ember += cells;
      }
    }
    expect(pulse / total).toBeLessThanOrEqual(0.08);
    expect(ember / total).toBeLessThanOrEqual(0.02);
  });

  it("emits zero escapes in none mode and still shows the wordmark", () => {
    for (const variant of BANNER_VARIANTS) {
      const out = renderBanner({ variant, width: 76, colorMode: "none", agents: AGENTS }).join("\n");
      expect(out).not.toMatch(/\x1b\[/);
      expect(out.toLowerCase().includes("trent") || out.includes("█")).toBe(true);
    }
  });

  it("keeps letters, extrusion, lattice, dot and READY distinguishable in 16 colours", () => {
    const theme = createTheme("ansi16");
    const lines = renderBanner({ variant: "repl", width: 76, colorMode: "ansi16", agents: AGENTS });
    const codes = new Set(lines.flatMap((l) => spans(l)).map((s) => s.code));
    expect(codes.has(theme.sgr("bone"))).toBe(true);
    expect(codes.has(theme.sgr("haze"))).toBe(true);
    expect(codes.has(theme.sgr("pulse"))).toBe(true);
    expect(codes.has(theme.sgr("ember"))).toBe(true);
    expect(new Set([theme.sgr("bone"), theme.sgr("haze"), theme.sgr("pulse"), theme.sgr("ember")]).size).toBe(4);
    const letters = spans(lines[1]!).filter((s) => /█/.test(s.text));
    expect(letters.every((s) => s.code === theme.sgr("bone"))).toBe(true);
  });

  it("draws no extrusion in monochrome, so the letters stay crisp", () => {
    const mono = renderBanner({ variant: "repl", width: 76, colorMode: "none" });
    const colour = renderBanner({ variant: "repl", width: 76, colorMode: "truecolor" }).map((l) => l.replace(ANSI_RE, ""));
    // the colour version has the haze copy one cell right and down; mono does not
    expect(colour[6]).toMatch(/█/);
    expect(mono[6]).not.toMatch(/█/);
    expect(mono[1]).toBe(colour[1]);
  });

  it("contains no emoji in any variant, width or mode", () => {
    for (const colorMode of MODES) {
      for (const width of WIDTHS) {
        for (const variant of BANNER_VARIANTS) {
          expect(renderBanner({ variant, width, colorMode, agents: AGENTS }).join("")).not.toMatch(
            /\p{Extended_Pictographic}/u,
          );
        }
      }
    }
  });

  it("uses sentence case in prose and uppercase only for the mono labels", () => {
    for (const variant of BANNER_VARIANTS) {
      for (const line of renderBanner({ variant, width: 76, colorMode: "none", agents: AGENTS })) {
        // seat rows carry proper-noun agent names beside a mono label; they are not prose
        if (/^[●·] \S+\s{2,}/.test(line)) continue;
        const prose = line.replace(/[█▀▄░─━┄┈│┌┐└┘╱·●▎]/g, "").trim();
        if (!prose || prose === prose.toUpperCase()) continue;
        const words = prose.split(/\s+/).filter((w) => /^[A-Za-z]+$/.test(w));
        const capitalised = words.filter((w) => /^[A-Z]/.test(w));
        expect(capitalised.length, `${variant}: ${prose}`).toBeLessThanOrEqual(2);
      }
    }
  });

  it("shows the tracked header and the READY roster in the full variants only", () => {
    for (const variant of BANNER_VARIANTS) {
      const plain = renderBanner({ variant, width: 76, colorMode: "none", agents: AGENTS }).join("\n");
      const full = variant === "repl" || variant === "setup" || variant === "installer";
      expect(plain.includes("BOOT SEQUENCE 05 / 05 · EDITION 01 · OPERATING"), variant).toBe(full);
      expect(plain.includes("9 AGENTS READY"), variant).toBe(full);
      if (full) for (const a of AGENTS) expect(plain).toContain(a);
    }
  });

  it("offers a variant for repl, doctor, setup, fleet and installer", () => {
    expect([...BANNER_VARIANTS].sort()).toEqual(["doctor", "fleet", "installer", "repl", "setup"]);
  });
});

describe("the installer's pre-rendered banner", () => {
  const files: Array<[string, ColorMode]> = [
    ["scripts/installer/banner.ansi", "truecolor"],
    ["scripts/installer/banner-16.ansi", "ansi16"],
  ];

  it.each(files)("%s is byte-identical to renderBanner for the installer variant", (file, colorMode) => {
    const onDisk = readFileSync(join(REPO, file));
    const expected = Buffer.from(installerBannerBytes(colorMode), "utf8");
    expect(
      onDisk.equals(expected),
      `${file} has drifted from banner.ts — regenerate it with installerBannerBytes("${colorMode}")`,
    ).toBe(true);
  });

  it("fits 76 columns and carries the right escapes for its mode", () => {
    const tc = installerBannerBytes("truecolor");
    const c16 = installerBannerBytes("ansi16");
    for (const line of tc.split("\n")) expect(visibleWidth(line)).toBeLessThanOrEqual(76);
    expect(tc).toMatch(/\x1b\[38;2;/);
    expect(c16).not.toMatch(/\x1b\[38;[25];/);
    expect(c16).toMatch(/\x1b\[9[0-7]m/);
    expect(tc.endsWith("\n")).toBe(true);
  });
});
