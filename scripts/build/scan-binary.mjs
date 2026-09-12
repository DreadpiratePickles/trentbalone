#!/usr/bin/env node
/**
 * scan-binary.mjs — refuse to ship a binary that contains a foreign object header
 * or an embedded native addon.
 *
 * WHY THIS EXISTS. `better-sqlite3` once cross-compiled with exit 0 and produced a
 * Linux ELF binary with two macOS Mach-O headers embedded inside it. Native `.node`
 * addons do not fail the cross-compile; they fail on the user's machine. The compile
 * is therefore not the gate — this scan is.
 *
 * Checks, per target:
 *   1. the file's own magic matches the object format the target is supposed to be;
 *   2. no VALIDATED foreign object header appears anywhere inside the file. A bare
 *      4-byte magic would false-positive roughly 2% of the time in an 80MB file, so a
 *      hit only counts when the bytes that follow it parse as a plausible header
 *      (Mach-O: known cputype + filetype in range; ELF: valid class/data/version/machine;
 *      PE: e_lfanew pointing at a real PE signature). A same-format payload of the
 *      TARGET's own architecture is reported but allowed — bun's Windows runtime
 *      genuinely embeds x86_64 PE payloads. Anything else is fatal;
 *   3. `*.node` path strings are listed as a NOTE. They are not proof of an embedded
 *      addon (Prisma ships an engine filename table, React exports `server.node.js`),
 *      but they are the first place to look when check 2 trips.
 *
 * Usage:  node scripts/build/scan-binary.mjs <bun-target> <path-to-binary>
 * Exit:   0 clean, 1 violation, 2 usage error.
 */

import { readFileSync, existsSync } from "node:fs";

const [, , target, file] = process.argv;
if (!target || !file) {
  console.error("usage: node scripts/build/scan-binary.mjs <bun-target> <binary>");
  process.exit(2);
}
if (!existsSync(file)) {
  console.error(`scan-binary: no such file: ${file}`);
  process.exit(2);
}

/** Expected object format per bun target. */
const FORMAT_BY_TARGET = {
  "bun-darwin-arm64": "macho",
  "bun-darwin-x64": "macho",
  "bun-linux-x64": "elf",
  "bun-windows-x64": "pe",
};
const expected = FORMAT_BY_TARGET[target];
if (!expected) {
  console.error(`scan-binary: unsupported target ${target}`);
  process.exit(2);
}

const buf = readFileSync(file);
const problems = [];

// ---------------------------------------------------------------- 1. own magic
function ownFormat(b) {
  if (b.length < 4) return "unknown";
  const m = b.readUInt32BE(0);
  if (m === 0x7f454c46) return "elf";
  if (m === 0xfeedface || m === 0xfeedfacf || m === 0xcefaedfe || m === 0xcffaedfe) return "macho";
  if (m === 0xcafebabe || m === 0xbebafeca) return "macho-fat";
  if (b[0] === 0x4d && b[1] === 0x5a) return "pe";
  return "unknown";
}
const actual = ownFormat(buf);
const actualNormalised = actual === "macho-fat" ? "macho" : actual;
if (actualNormalised !== expected) {
  problems.push(`header mismatch: target ${target} expects ${expected}, file is ${actual}`);
}

// ------------------------------------------------- 2. validated foreign headers
// A bare 4-byte magic false-positives roughly 2% of the time in an 80MB file, so a hit only
// counts when the bytes after it parse as a plausible header. Each validator returns the
// architecture it found, or null for "not a header".
//
// Two different verdicts:
//   * a header of a DIFFERENT object format  -> always fatal. This is the exact shape of the
//     verified failure: Mach-O headers inside an ELF binary.
//   * a header of the SAME format at a non-zero offset -> fatal only if its architecture does
//     not match the target. bun's own Windows runtime legitimately embeds x86_64 PE payloads.

const MACHO_CPU = {
  0x00000007: "x86",
  0x01000007: "x86_64",
  0x0000000c: "arm",
  0x0100000c: "arm64",
};
const EXPECTED_ARCH = target.endsWith("arm64") ? "arm64" : "x86_64";

function machoAt(b, off) {
  if (off + 16 > b.length) return null;
  const m = b.readUInt32BE(off);
  const le = m === 0xcefaedfe || m === 0xcffaedfe; // little-endian magic as written on disk
  const be = m === 0xfeedface || m === 0xfeedfacf;
  if (!le && !be) return null;
  const cpu = (le ? b.readUInt32LE(off + 4) : b.readUInt32BE(off + 4)) >>> 0;
  const filetype = le ? b.readUInt32LE(off + 12) : b.readUInt32BE(off + 12);
  if (!(cpu in MACHO_CPU) || filetype < 1 || filetype > 12) return null;
  return MACHO_CPU[cpu];
}

function elfAt(b, off) {
  if (off + 20 > b.length) return null;
  if (b.readUInt32BE(off) !== 0x7f454c46) return null;
  const cls = b[off + 4], data = b[off + 5], ver = b[off + 6];
  if ((cls !== 1 && cls !== 2) || (data !== 1 && data !== 2) || ver !== 1) return null;
  const etype = data === 1 ? b.readUInt16LE(off + 16) : b.readUInt16BE(off + 16);
  if (etype < 1 || etype > 4) return null; // REL | EXEC | DYN | CORE
  const machine = data === 1 ? b.readUInt16LE(off + 18) : b.readUInt16BE(off + 18);
  return machine === 0x3e ? "x86_64" : machine === 0xb7 ? "arm64" : `elf-machine-0x${machine.toString(16)}`;
}

function peAt(b, off) {
  if (off + 0x40 > b.length) return null;
  if (b[off] !== 0x4d || b[off + 1] !== 0x5a) return null;
  const e_lfanew = b.readUInt32LE(off + 0x3c);
  if (e_lfanew < 0x40 || off + e_lfanew + 6 > b.length) return null;
  if (b.readUInt32BE(off + e_lfanew) !== 0x50450000) return null;
  const machine = b.readUInt16LE(off + e_lfanew + 4);
  return machine === 0x8664 ? "x86_64" : machine === 0xaa64 ? "arm64" : `pe-machine-0x${machine.toString(16)}`;
}

const FORMATS = [
  { name: "Mach-O", key: "macho", at: machoAt, magics: [
      Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), Buffer.from([0xce, 0xfa, 0xed, 0xfe]),
      Buffer.from([0xfe, 0xed, 0xfa, 0xcf]), Buffer.from([0xfe, 0xed, 0xfa, 0xce]),
  ] },
  { name: "ELF", key: "elf", at: elfAt, magics: [Buffer.from([0x7f, 0x45, 0x4c, 0x46])] },
  { name: "PE", key: "pe", at: peAt, magics: [Buffer.from("MZ", "latin1")] },
];

for (const fmt of FORMATS) {
  const native = fmt.key === expected;
  const bad = [];
  const benign = [];
  for (const magic of fmt.magics) {
    let i = 0;
    for (;;) {
      const at = buf.indexOf(magic, i);
      if (at === -1) break;
      i = at + 1;
      if (at === 0) continue; // the file's own header
      const arch = fmt.at(buf, at);
      if (!arch) continue;
      if (!native || arch !== EXPECTED_ARCH) bad.push(`${at} (${arch})`);
      else benign.push(at);
      if (bad.length > 8) break;
    }
    if (bad.length > 8) break;
  }
  if (bad.length) {
    problems.push(
      `${native ? "wrong-architecture" : "foreign"} ${fmt.name} object header(s) embedded at ` +
        `offset(s) ${bad.slice(0, 8).join(", ")} - target is ${target} (${EXPECTED_ARCH})`
    );
  } else if (benign.length) {
    console.warn(
      `scan-binary: NOTE ${benign.length} additional ${fmt.name} ${EXPECTED_ARCH} payload(s) ` +
        `at offset(s) ${benign.slice(0, 4).join(", ")} - correct architecture, part of the bun runtime`
    );
  }
}

// -------------------------------------------------- 3. .node references (warning)
// A `.node` STRING is not proof of an embedded addon: @prisma/client ships a table of
// engine filenames and React exports files literally named `server.node.js`. An addon that
// was actually embedded shows up as a foreign object header, which check 2 fails on. So
// this is reported, not fatal — but it is the first place to look when check 2 trips.
const addonRe = /[A-Za-z0-9_@./+-]{3,120}\.node\b/g;
const text = buf.toString("latin1");
const addons = new Set();
for (const m of text.matchAll(addonRe)) {
  const hit = m[0];
  if (!hit.includes("/")) continue;
  addons.add(hit);
  if (addons.size >= 12) break;
}
if (addons.size) {
  console.warn(
    `scan-binary: NOTE ${addons.size} '.node' path string(s) present (no object header found, ` +
      `so nothing is actually embedded): ${[...addons].slice(0, 6).join(", ")}${addons.size > 6 ? ", ..." : ""}`
  );
}

// -------------------------------------------------------------------- verdict
if (problems.length) {
  console.error(`scan-binary: FAIL ${file} (${target})`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    "\nA cross-compile exiting 0 is not evidence. Remove the native addon from the CLI\n" +
      "import graph; do NOT paper over it with --external."
  );
  process.exit(1);
}
console.log(`scan-binary: PASS ${file} (${target}, ${actual}, ${buf.length} bytes)`);
