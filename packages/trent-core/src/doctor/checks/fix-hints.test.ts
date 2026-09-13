/**
 * Every `trent <word>` a doctor check tells the user to run must be a command the CLI registers.
 *
 * The cron check used to say "Run `trent cron add <schedule> <agent>`" and there was no `cron`
 * command (docs/doctor.md, "Not yet implemented"). A hint that points at nothing is worse than no
 * hint. This test greps the CLI's top-level command names out of `apps/cli/src/commands/groups/`
 * and asserts every `trent <word>` inside any check's source is one of them.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../../..");
const CLI_GROUPS_DIR = path.join(REPO_ROOT, "apps/cli/src/commands/groups");
const CHECKS_DIR = HERE;

/** Top-level names only: the `name:` that immediately follows `…Spec: CommandSpec = {`. */
function registeredTopLevelCommands(): Set<string> {
  const names = new Set<string>();
  for (const file of fs.readdirSync(CLI_GROUPS_DIR).filter((f) => f.endsWith(".ts"))) {
    const src = fs.readFileSync(path.join(CLI_GROUPS_DIR, file), "utf8");
    for (const m of src.matchAll(/Spec\b[^=]*=\s*\{\s*name:\s*"([a-z-]+)/g)) names.add(m[1]);
  }
  return names;
}

/** Every `trent <word>` inside a fixHint string, per source file. */
function hintedCommands(): { file: string; word: string; line: number }[] {
  const found: { file: string; word: string; line: number }[] = [];
  for (const file of fs.readdirSync(CHECKS_DIR).filter((f) => f.endsWith(".ts") && !f.includes(".test."))) {
    const lines = fs.readFileSync(path.join(CHECKS_DIR, file), "utf8").split("\n");
    lines.forEach((text, i) => {
      if (!/fixHint/.test(text)) return;
      for (const m of text.matchAll(/`trent ([a-z-]+)/g)) found.push({ file, word: m[1], line: i + 1 });
    });
  }
  return found;
}

describe("doctor fix hints", () => {
  const registered = registeredTopLevelCommands();

  it("reads a real command list from the CLI sources", () => {
    expect(registered.has("doctor")).toBe(true);
    expect(registered.has("config")).toBe(true);
    expect(registered.size).toBeGreaterThan(10);
  });

  it("never names a command the CLI does not register", () => {
    const hints = hintedCommands();
    expect(hints.length).toBeGreaterThan(0);
    const bogus = hints.filter((h) => !registered.has(h.word)).map((h) => `${h.file}:${h.line} -> trent ${h.word}`);
    expect(bogus).toEqual([]);
  });

  it("the cron check no longer claims a `trent cron` command exists", () => {
    const src = fs.readFileSync(path.join(CHECKS_DIR, "cron.ts"), "utf8");
    expect(src).not.toMatch(/trent cron/);
  });
});
