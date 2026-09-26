/**
 * C6 — every page a user can read names only commands, flags and files that exist.
 *
 * `docs-truth.test.ts` (G4) checked four pages; the other twenty-seven drifted unchecked, and the
 * council found commands named to users that were never registered (`trent checkpoints`) and rows
 * proved wrong still published (02_plan/output/hermes-council-verdict-2026-09-26.md, C6). This file
 * reads every `docs/*.md` off the disk, so a page is covered the day it is added, plus README.md,
 * AGENTS.md and CONTRIBUTING.md. AGENTS.md invariant 5: no claim without something executable.
 *
 * What is asserted, each against the code at run time:
 * - every `trent <cmd>` and `trent <cmd> <sub>` resolves in `COMMAND_SPECS`;
 * - every `--flag` written after a command is one that command accepts (its own options plus the
 *   global set every command gets from `defineCommand`), and a flag written after a bare `trent` is
 *   one the root program declares;
 * - every file path in backticks under `packages/`, `apps/cli/` or `scripts/` exists.
 *
 * Two exemptions, both listed rather than matched: the sections that exist to name what is absent
 * (ABSENCE_SECTIONS), and fenced blocks that show another tool's commands (OTHER_TOOL_FENCES).
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildProgram, COMMAND_SPECS } from "../index.js";
import { GLOBAL_LONG_FLAGS, type CommandSpec } from "../registry.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");

/** Every page: the three at the root, then every `docs/*.md` (not `docs/sessions/`, which is a log). */
const PAGES: readonly string[] = [
  "README.md",
  "AGENTS.md",
  "CONTRIBUTING.md",
  ...fs
    .readdirSync(path.join(REPO_ROOT, "docs"))
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => `docs/${name}`),
];

/**
 * The sections whose job is to name what does not exist yet. A page and its heading text, exact:
 * a new absence section must be added here by hand, and `docs-truth.test.ts`'s pattern skip is held
 * to this list by "lists every absence heading".
 */
const ABSENCE_SECTIONS: readonly { readonly page: string; readonly heading: string }[] = [
  { page: "docs/configuration.md", heading: "Not yet implemented" },
  { page: "docs/connect.md", heading: "Not yet implemented" },
  { page: "docs/desktop.md", heading: "Not yet implemented" },
  { page: "docs/doctor.md", heading: "Not yet implemented" },
  { page: "docs/fleet.md", heading: "Not yet implemented" },
  { page: "docs/gateway.md", heading: "Not yet implemented" },
  { page: "docs/getting-started.md", heading: "Not yet implemented" },
  { page: "docs/security.md", heading: "Not yet implemented" },
  { page: "docs/skills.md", heading: "Not yet implemented" },
  { page: "docs/terminal.md", heading: "Not yet implemented" },
  { page: "docs/webhooks.md", heading: "Not yet implemented" },
];

/**
 * Fenced blocks that show ANOTHER tool's commands, named by page and the block's first line. A
 * `trent` inside one is that tool's argument, not a claim about this CLI.
 */
const OTHER_TOOL_FENCES: readonly { readonly page: string; readonly firstLine: string; readonly why: string }[] = [];

function read(relative: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relative), "utf8");
}

// ── reading a page ────────────────────────────────────────────────────────────

interface Line {
  readonly page: string;
  readonly number: number;
  readonly text: string;
  /** Inside a ``` fence, or an indented code line: a transcript or a command list. */
  readonly code: boolean;
}

/** The lines a claim can live on: absence sections and other tools' fences removed. */
function claimLines(page: string, markdown: string): Line[] {
  const absent = ABSENCE_SECTIONS.filter((entry) => entry.page === page).map((entry) => entry.heading);
  const exemptFences = OTHER_TOOL_FENCES.filter((entry) => entry.page === page).map((entry) => entry.firstLine);
  const kept: Line[] = [];
  let skippingFrom = 0;
  let fence: "none" | "claims" | "exempt" = "none";
  let fenceOpenedAt = -1;
  markdown.split("\n").forEach((text, index) => {
    const number = index + 1;
    if (/^\s*```/.test(text)) {
      fence = fence === "none" ? "claims" : "none";
      fenceOpenedAt = number;
      return;
    }
    if (fence !== "none" && number === fenceOpenedAt + 1 && exemptFences.includes(text.trim())) fence = "exempt";
    if (fence === "none") {
      const heading = /^(#{1,6})\s+(.*)$/.exec(text);
      if (heading !== null) {
        const level = heading[1]!.length;
        if (skippingFrom > 0 && level <= skippingFrom) skippingFrom = 0;
        if (absent.includes(heading[2]!.trim())) skippingFrom = level;
      }
    }
    if (skippingFrom > 0 || fence === "exempt") return;
    kept.push({ page, number, text, code: fence === "claims" || /^ {4,}\S/.test(text) });
  });
  return kept;
}

// ── the CLI surface ───────────────────────────────────────────────────────────

/** A spec's Commander name carries its arguments (`install <agentId>`); the head is the name. */
const head = (spec: CommandSpec): string => spec.name.split(" ")[0] ?? spec.name;
const findSpec = (specs: readonly CommandSpec[] | undefined, name: string): CommandSpec | undefined =>
  specs?.find((spec) => head(spec) === name);

/**
 * `trent <command> [<sub>]`, and the `npm run [--silent] cli[:bun] --` spellings a clone uses. A
 * token that starts with `-`, `<`, `"` or a backtick is an option or an argument, never a
 * subcommand, so each capture demands a lowercase letter first. Separators are horizontal
 * whitespace only: a line ending in `--` must not borrow the next line's first word.
 */
const PREFIX = String.raw`(?:^|[\s\`(])(?:trent|npm run(?: --silent)? cli(?::bun)? --)`;
const INVOCATION = new RegExp(`${PREFIX}[^\\S\\n]+([a-z][a-z0-9-]*)(?:[^\\S\\n]+([a-z][a-z0-9|\\\\-]*))?`, "g");
/** A bare `trent` followed by flags: those are the root program's. */
const ROOT_FLAGS = new RegExp(`${PREFIX}((?:[^\\S\\n]+--[a-z][a-z0-9-]*)+)`, "g");
const FLAG = /(?:^|[\s`(\[])(--[a-z][a-z0-9-]*)(?![A-Za-z0-9_])/g;
/** A quoted argument is a value, whatever it contains: `--gate "typecheck=npx tsc --noEmit"`. */
const QUOTED = /"[^"]*"|'[^']*'/g;

interface Mention {
  readonly where: string;
  readonly command: string;
  readonly sub?: string;
  /** The deepest spec the words resolve to, when every word resolved. */
  readonly spec?: CommandSpec;
  readonly flags: readonly string[];
}

/** Where the words after an invocation stop belonging to it. */
function segmentEnd(line: Line, from: number, nextInvocation: number): number {
  const rest = line.text.slice(from, nextInvocation);
  const insideSpan = !line.code && (line.text.slice(0, from).match(/`/g)?.length ?? 0) % 2 === 1;
  const stops = line.code
    ? /\s\|\s|&&|;|\s#|\s--(?:\s|$)/
    : insideSpan
      ? /`|\s\|\s|&&|;|\s--(?:\s|$)/
      : /`|,\s|\.\s|;|\)/;
  const stop = stops.exec(rest);
  return stop === null ? nextInvocation : from + stop.index;
}

function mentions(line: Line): Mention[] {
  const found: Mention[] = [];
  const matches = [...line.text.matchAll(INVOCATION)];
  matches.forEach((match, index) => {
    const end = match.index! + match[0].length;
    const next = matches[index + 1]?.index ?? line.text.length;
    const segment = line.text.slice(end, segmentEnd(line, end, next));
    const where = `${line.page}:${line.number}`;
    const command = match[1]!;
    const subs = match[2] === undefined ? [undefined] : match[2].split(/[\\|]+/).filter((part) => part !== "");
    for (const sub of subs) {
      let spec = findSpec(COMMAND_SPECS, command);
      if (spec !== undefined && sub !== undefined && spec.subcommands !== undefined) {
        // `connect [provider]` is a group that also takes an argument: a word that is not one of
        // its subcommands is that argument, and the flags after it are the group's own.
        spec = findSpec(spec.subcommands, sub) ?? (takesArgument(spec) ? spec : undefined);
      }
      // Deeper levels (`trent cron queue list`): keep descending while the next word is a subcommand.
      for (const word of segment.trim().split(/\s+/)) {
        const deeper = spec?.subcommands === undefined ? undefined : findSpec(spec.subcommands, word);
        if (deeper === undefined) break;
        spec = deeper;
      }
      const flags = [...segment.replace(QUOTED, '""').matchAll(FLAG)].map((flag) => flag[1]!);
      found.push({ where, command, ...(sub === undefined ? {} : { sub }), ...(spec === undefined ? {} : { spec }), flags });
    }
  });
  return found;
}

/** The spec's Commander name declares an argument after the command word. */
const takesArgument = (spec: CommandSpec): boolean => /\s[<[]/.test(spec.name);

function acceptedFlags(spec: CommandSpec): Set<string> {
  const own = (spec.options ?? []).flatMap((option) => option.flags.match(/--[a-z][a-z0-9-]*/g) ?? []);
  return new Set([...GLOBAL_LONG_FLAGS, ...own, "--help"]);
}

const allLines = PAGES.flatMap((page) => claimLines(page, read(page)));
const allMentions = allLines.flatMap(mentions);

describe("every page lists its absence sections explicitly", () => {
  const headings = (page: string): string[] =>
    [...read(page).matchAll(/^#{1,6}\s+(.*)$/gm)].map((match) => match[1]!.trim());

  it("lists only headings that exist", () => {
    const missing = ABSENCE_SECTIONS.filter((entry) => !headings(entry.page).includes(entry.heading));
    expect(missing).toEqual([]);
  });

  it("lists every absence heading, so no section is skipped by pattern alone", () => {
    const unlisted: string[] = [];
    for (const page of PAGES) {
      for (const heading of headings(page)) {
        if (!/not yet implemented/i.test(heading)) continue;
        if (!ABSENCE_SECTIONS.some((entry) => entry.page === page && entry.heading === heading)) unlisted.push(`${page}: ${heading}`);
      }
    }
    expect(unlisted).toEqual([]);
  });

  it("names only fences that exist", () => {
    const missing = OTHER_TOOL_FENCES.filter((entry) => !read(entry.page).split("\n").some((line) => line.trim() === entry.firstLine));
    expect(missing).toEqual([]);
  });
});

describe("every page names commands the registry has", () => {
  it("covers every docs page and the three root pages", () => {
    expect(PAGES.length).toBeGreaterThanOrEqual(34);
    expect(new Set(allMentions.map((mention) => mention.where.split(":")[0])).size).toBeGreaterThan(25);
  });

  it("resolves every documented command", () => {
    const unknown = allMentions
      .filter((mention) => findSpec(COMMAND_SPECS, mention.command) === undefined)
      .map((mention) => `${mention.where}: trent ${mention.command}`);
    expect([...new Set(unknown)]).toEqual([]);
  });

  it("resolves every documented subcommand", () => {
    const unknown = allMentions
      .filter((mention) => mention.sub !== undefined)
      .filter((mention) => findSpec(COMMAND_SPECS, mention.command)?.subcommands !== undefined && mention.spec === undefined)
      .map((mention) => `${mention.where}: trent ${mention.command} ${mention.sub}`);
    expect([...new Set(unknown)]).toEqual([]);
  });

  it("names only flags the command accepts", () => {
    const wrong: string[] = [];
    for (const mention of allMentions) {
      if (mention.spec === undefined) continue;
      const accepted = acceptedFlags(mention.spec);
      for (const flag of mention.flags) {
        if (!accepted.has(flag)) wrong.push(`${mention.where}: trent ${mention.command}${mention.sub === undefined ? "" : ` ${mention.sub}`} ${flag}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("names only flags the root program declares after a bare trent", () => {
    const program = buildProgram({ io: { out: () => undefined, err: () => undefined } });
    const accepted = new Set([...program.options.map((option) => option.long), "--help"]);
    const wrong: string[] = [];
    for (const line of allLines) {
      for (const match of line.text.matchAll(ROOT_FLAGS)) {
        for (const flag of match[1]!.trim().split(/\s+/)) {
          if (!accepted.has(flag)) wrong.push(`${line.page}:${line.number}: trent ${flag}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });
});

describe("every page names files that exist", () => {
  /** `packages/…`, `apps/cli/…`, `scripts/…` in a code span; a `:12` or `:12-40` line suffix is dropped. */
  const REPO_PATH = /`((?:packages|apps\/cli|scripts)\/[A-Za-z0-9_./{},*-]*?)(?::[0-9][0-9,-]*)?`/g;

  /** `{a,b}.ts` is two files written once; a glob or a placeholder is checked up to its first wildcard. */
  function expand(candidate: string): string[] {
    const brace = /\{([^}]*)\}/.exec(candidate);
    if (brace !== null) return brace[1]!.split(",").flatMap((part) => expand(candidate.replace(brace[0], part)));
    const wildcard = candidate.indexOf("*");
    return [wildcard === -1 ? candidate : candidate.slice(0, candidate.lastIndexOf("/", wildcard) + 1)];
  }

  it("resolves every repository path a page puts in backticks", () => {
    const missing: string[] = [];
    let checked = 0;
    for (const line of allLines) {
      for (const match of line.text.matchAll(REPO_PATH)) {
        for (const candidate of expand(match[1]!)) {
          checked += 1;
          if (!fs.existsSync(path.join(REPO_ROOT, candidate))) missing.push(`${line.page}:${line.number}: ${match[1]}`);
        }
      }
    }
    expect(checked).toBeGreaterThan(50);
    expect(missing).toEqual([]);
  });
});

/**
 * The README's comparison with Hermes is the page's most quoted claim, so every row names the test a
 * stranger re-runs to check it (council C6: "every README comparison row names the test"). The
 * rows are read from the table and the tests from the list under it; neither is spelled here.
 */
describe("the README names a test for every comparison row", () => {
  const readme = read("README.md");
  const start = readme.indexOf("## How it compares with Hermes Agent");
  const section = readme.slice(start, readme.indexOf("\n## ", start + 3));
  const rows = [...section.matchAll(/^\| ([^|]+?) \| .* \| .* \|$/gm)].map((match) => match[1]!.trim());
  const named = new Map(
    [...section.matchAll(/^- \*\*([^*]+)\*\*: (.+)$/gm)].map((match) => [match[1]!, [...match[2]!.matchAll(/`([^`]+\.test\.[a-z]+)`/g)].map((file) => file[1]!)]),
  );

  it("names a test for every comparison row", () => {
    expect(start).toBeGreaterThan(-1);
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.filter((row) => (named.get(row) ?? []).length === 0)).toEqual([]);
  });

  it("names only test files that exist, and only rows the table has", () => {
    expect([...named.values()].flat().filter((file) => !fs.existsSync(path.join(REPO_ROOT, file)))).toEqual([]);
    expect([...named.keys()].filter((row) => !rows.includes(row))).toEqual([]);
  });
});
