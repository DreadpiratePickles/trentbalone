#!/usr/bin/env node
/**
 * Authors the Trent compact mark as a 1024x1024 PNG for `tauri icon`.
 *
 * The repo contains ZERO image assets — the product logo is pure CSS/JSX
 * (`apps/web/components/ui/index.tsx` ConsoleMark). The compact mark, per
 * `01_discovery/output/style-contract.md`, is "a mint dot before an Inter Black T".
 *
 * The `T` is constructed geometrically rather than typeset, deliberately:
 *  - Inter Black is not installed on any machine we build on, and vendoring a
 *    webfont for one glyph is a dependency we do not need.
 *  - An Inter Black capital T IS two rectangles. Its proportions (crossbar
 *    0.21 of cap height, stem 0.215, total width 0.80) are reproduced exactly,
 *    so the drawn glyph and the typeset glyph are the same shape.
 *
 * Colours are the authoritative tokens from the style contract — no invention:
 *   obsidian #0A0A0F   bone #F1ECE2   pulse (mint) #6EE7B7
 *
 * Square corners: macOS applies its own superellipse mask.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../src-tauri/icon-source.png");

const OBSIDIAN = "#0A0A0F";
const BONE = "#F1ECE2";
const PULSE = "#6EE7B7";

const SIZE = 1024;

// --- glyph geometry (Inter Black `T`) ---
const H = 620; // cap height
const W = Math.round(0.8 * H); // 496 — total glyph width
const BAR = Math.round(0.21 * H); // 130 — crossbar thickness
const STEM = Math.round(0.215 * H); // 133 — stem width

// --- the mint dot: diameter ~32% of the glyph height, upper-left of the mark ---
const DOT_D = Math.round(0.32 * H); // 198
const DOT_R = DOT_D / 2;
const DOT_DX = Math.round(0.28 * DOT_D); // how far left of the glyph the dot sits
const DOT_DY = Math.round(0.1 * DOT_D); // how far above the glyph the dot sits

// --- optical centring of the whole mark (glyph + dot), raised slightly:
// a cap-height block mathematically centred reads low.
const markW = W + DOT_DX;
const markH = H + DOT_DY;
const glyphX = (SIZE - markW) / 2 + DOT_DX;
const glyphY = (SIZE - markH) / 2;

const dotCx = glyphX - DOT_DX + DOT_R;
const dotCy = glyphY - DOT_DY + DOT_R;

const GLOW_R = Math.round(DOT_R * 3.0);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <defs>
    <radialGradient id="glow" cx="50%" cy="50%" r="50%">
      <stop offset="0%"   stop-color="${PULSE}" stop-opacity="0.55"/>
      <stop offset="38%"  stop-color="${PULSE}" stop-opacity="0.24"/>
      <stop offset="68%"  stop-color="${PULSE}" stop-opacity="0.07"/>
      <stop offset="100%" stop-color="${PULSE}" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <!-- obsidian ground, square corners: macOS applies its own mask -->
  <rect x="0" y="0" width="${SIZE}" height="${SIZE}" fill="${OBSIDIAN}"/>

  <!-- soft mint glow behind the dot -->
  <circle cx="${dotCx}" cy="${dotCy}" r="${GLOW_R}" fill="url(#glow)"/>

  <!-- Inter Black T, bone -->
  <rect x="${glyphX}" y="${glyphY}" width="${W}" height="${BAR}" fill="${BONE}"/>
  <rect x="${glyphX + (W - STEM) / 2}" y="${glyphY}" width="${STEM}" height="${H}" fill="${BONE}"/>

  <!-- the pulse dot -->
  <circle cx="${dotCx}" cy="${dotCy}" r="${DOT_R}" fill="${PULSE}"/>
</svg>`;

mkdirSync(dirname(OUT), { recursive: true });
const png = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
writeFileSync(OUT, png);
const meta = await sharp(png).metadata();
console.log(`wrote ${OUT} (${meta.width}x${meta.height}, ${png.length} bytes)`);
