/**
 * 3.10 — the canned paths are deleted, not patched.
 *
 * A source scan, so the failure mode is caught by the repository rather than by a user
 * typing "hello" and receiving a pre-written paragraph. This file is the only place the
 * forbidden literals are allowed to appear, because it asserts their absence.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPL_DIR = path.resolve(here, "..");
const CLI_SRC = path.resolve(here, "../..");
const CORE_SRC = path.resolve(here, "../../../../../packages/trent-core/src");

function sources(root: string, opts: { includeTests: boolean }): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === "node_modules" || entry === "generated" || entry === "dist") continue;
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx|mts|mjs)$/.test(entry)) continue;
      if (!opts.includeTests && /\.test\.tsx?$|__tests__/.test(full)) continue;
      out.push(full);
    }
  };
  walk(root);
  return out;
}

function offenders(files: string[], pattern: RegExp): string[] {
  const hits: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const [index, line] of text.split("\n").entries()) {
      if (pattern.test(line)) hits.push(`${path.relative(CLI_SRC, file)}:${index + 1}: ${line.trim()}`);
    }
  }
  return hits;
}

describe("the canned response paths are gone", () => {
  it("has no generateAutonomousReply anywhere in the CLI or the core", () => {
    const files = [...sources(CLI_SRC, { includeTests: true }), ...sources(CORE_SRC, { includeTests: true })].filter(
      (f) => f !== path.join(here, "no-canned.test.ts"),
    );
    expect(offenders(files, /generateAutonomousReply/)).toEqual([]);
  });

  it("has no line beginning with the proxy's canned literal", () => {
    const files = [...sources(CLI_SRC, { includeTests: true }), ...sources(CORE_SRC, { includeTests: true })].filter(
      (f) => f !== path.join(here, "no-canned.test.ts"),
    );
    // Anchored, so the tests that assert /^Trent proxy response/ never matches are fine.
    expect(offenders(files, /^\s*["'`]Trent proxy response/)).toEqual([]);
  });

  it("has no canned agent prose in the REPL", () => {
    const files = sources(REPL_DIR, { includeTests: false });
    const canned = /(Ahoy matey|INPUT_ACKNOWLEDGED|I've analyzed:|Processing DAG subtask)/;
    expect(offenders(files, canned)).toEqual([]);
  });
});

describe("no hard-coded sample money", () => {
  it("does not contain the old 0.12 / 0.04 placeholder costs", () => {
    const files = sources(REPL_DIR, { includeTests: false });
    expect(offenders(files, /\b0\.12\b|\b0\.04\b/)).toEqual([]);
  });

  it("does not write a dollar float literal at all", () => {
    const files = sources(REPL_DIR, { includeTests: false });
    // Money is integer cents; the only float in the REPL is the one formatCents produces.
    expect(offenders(files, /\$\d+\.\d\d/)).toEqual([]);
  });
});

describe("brand rules the REPL must not break", () => {
  it("contains no emoji in any REPL source", () => {
    const files = sources(REPL_DIR, { includeTests: false });
    expect(offenders(files, /\p{Extended_Pictographic}/u)).toEqual([]);
  });

  it("writes no hex colour and no raw SGR escape outside the ui module", () => {
    const files = sources(REPL_DIR, { includeTests: false });
    expect(offenders(files, /chalk\.hex|#[0-9A-Fa-f]{6}/)).toEqual([]);
    // Escapes the REPL legitimately owns are keyboard-protocol control sequences,
    // never colour. Colour comes from the ui theme.
    expect(offenders(files, /\\x1b\[[0-9;]*m/)).toEqual([]);
  });

  it("keeps every REPL file under 500 lines", () => {
    const tooLong = sources(REPL_DIR, { includeTests: true })
      .map((f) => [path.relative(REPL_DIR, f), readFileSync(f, "utf8").split("\n").length] as const)
      .filter(([, n]) => n > 500)
      .map(([f, n]) => `${f}: ${n}`);
    expect(tooLong).toEqual([]);
  });
});
