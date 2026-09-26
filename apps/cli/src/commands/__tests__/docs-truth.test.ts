/**
 * G4 — the four user-facing documents are checked against the code, not against memory.
 *
 * README.md, docs/getting-started.md, docs/configuration.md and docs/security.md are the pages a
 * founder reads before running anything, so a command that no longer exists, a config key that was
 * never in the schema and a slash command nobody registered are all defects of the same kind:
 * AGENTS.md invariant 5, no claim without something that can be executed.
 *
 * Nothing here is a hard-coded list. Every expectation is read out of the code at run time —
 * `COMMAND_SPECS` for the CLI surface, `TrentConfigSchema` for the settings, `REPL_COMMANDS` for
 * the slash commands, `DEFAULT_CHECKS` for the doctor — so a document can only stay correct by
 * being corrected when the code moves.
 *
 * Two deliberate exemptions, both narrow. A "Not yet implemented" heading is where a page names
 * what does NOT exist, so its section is not scanned. And `/stop` is registered on the REPL engine
 * rather than in the command table, so the slash vocabulary is `commandNames()` plus that one
 * constant, imported rather than spelled.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { STOP_COMMAND } from "@trent/core/gateway/index.js";
import { TrentConfigSchema, ToolsetSchema } from "@trent/core/config/schema.js";
import { DEFAULT_CONFIG } from "@trent/core/config/index.js";
import { DEFAULT_CHECKS } from "@trent/core/doctor/DoctorRunner.js";
import { COMMAND_SPECS } from "../index.js";
import type { CommandSpec } from "../registry.js";
import { commandNames } from "../../repl/commands.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");

/** The four documents this suite is about, repo-relative so a failure names the page. */
const DOCUMENTS = ["README.md", "docs/getting-started.md", "docs/configuration.md", "docs/security.md"] as const;

/**
 * Pages whose doctor check count must equal the registry's length, and whether their fenced
 * blocks are claims or transcripts. README's fences are annotated command lists, so they carry
 * claims; doctor.md's fence is a captured run that says so in the line under it.
 */
const DOCTOR_COUNT_PAGES: readonly { readonly page: string; readonly fencesAreClaims: boolean }[] = [
  { page: "README.md", fencesAreClaims: true },
  { page: "docs/doctor.md", fencesAreClaims: false },
];

function read(relative: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relative), "utf8");
}

// ── reading a markdown page ───────────────────────────────────────────────────

/**
 * Drop every section under a "Not yet implemented" heading, up to the next heading of the same or
 * a shallower level. Those sections exist to name what is absent; asserting they resolve would
 * force a page to delete an honest disclaimer.
 */
function withoutNotYetSections(markdown: string): string {
  const kept: string[] = [];
  let skippingFrom = 0;
  for (const line of markdown.split("\n")) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      const level = heading[1]!.length;
      if (skippingFrom > 0 && level <= skippingFrom) skippingFrom = 0;
      if (/not yet implemented/i.test(heading[2]!)) {
        skippingFrom = level;
        continue;
      }
    }
    if (skippingFrom === 0) kept.push(line);
  }
  return kept.join("\n");
}

/** Prose only: fenced blocks are transcripts and file trees, which are not claims of this shape. */
function withoutFences(markdown: string): string {
  const kept: string[] = [];
  let inside = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*```/.test(line)) {
      inside = !inside;
      continue;
    }
    if (!inside) kept.push(line);
  }
  return kept.join("\n");
}

/** Every fenced block whose info string names one of `languages`. */
function fencedBlocks(markdown: string, languages: readonly string[]): string[] {
  const blocks: string[] = [];
  let current: string[] | undefined;
  for (const line of markdown.split("\n")) {
    const fence = /^\s*```(\w*)/.exec(line);
    if (fence !== null) {
      if (current === undefined) {
        if (languages.includes(fence[1]!)) current = [];
      } else {
        blocks.push(current.join("\n"));
        current = undefined;
      }
      continue;
    }
    if (current !== undefined) current.push(line);
  }
  return blocks;
}

// ── the CLI surface ───────────────────────────────────────────────────────────

/** A spec's Commander name carries its arguments (`install <agentId>`); the head is the name. */
function head(spec: CommandSpec): string {
  return spec.name.split(" ")[0] ?? spec.name;
}

function findSpec(specs: readonly CommandSpec[], name: string): CommandSpec | undefined {
  return specs.find((spec) => head(spec) === name);
}

function countSpecs(specs: readonly CommandSpec[], includeHidden: boolean): number {
  let total = 0;
  for (const spec of specs) {
    if (!includeHidden && spec.hidden === true) continue;
    total += 1;
    if (spec.subcommands !== undefined) total += countSpecs(spec.subcommands, includeHidden);
  }
  return total;
}

interface Invocation {
  readonly page: string;
  readonly command: string;
  readonly sub?: string;
}

/**
 * `trent <command> [<sub>]`, and the `npm run cli -- <command> [<sub>]` spelling the pages use
 * until a binary exists. A token that starts with `-`, `<`, `"` or a backtick is an option or an
 * argument, never a subcommand, so the capture demands a lowercase letter first. Separators are
 * horizontal whitespace only: a line ending in `--` must not borrow the next line's first word.
 */
const INVOCATION = /(?:^|[\s`(])(?:trent|npm run cli --)[^\S\n]+([a-z][a-z0-9-]*)(?:[^\S\n]+([a-z][a-z0-9|\\-]*))?/g;

function invocations(page: string, markdown: string): Invocation[] {
  const found: Invocation[] = [];
  for (const match of withoutNotYetSections(markdown).matchAll(INVOCATION)) {
    const command = match[1]!;
    const sub = match[2];
    if (sub === undefined) {
      found.push({ page, command });
      continue;
    }
    // `trent mcp list\|add\|remove\|test` is four invocations written once.
    for (const alternative of sub.split(/[\\|]+/).filter((part) => part !== "")) {
      found.push({ page, command, sub: alternative });
    }
  }
  return found;
}

// ── the config schema ─────────────────────────────────────────────────────────

/** Peel `.default()` / `.optional()` wrappers until the underlying type is reachable. */
function unwrap(schema: unknown): unknown {
  let current = schema;
  for (let depth = 0; depth < 8; depth += 1) {
    const inner = (current as { _def?: { innerType?: unknown } })?._def?.innerType;
    if (inner === undefined) return current;
    current = inner;
  }
  return current;
}

/** The object shape behind a schema, or undefined when it is a record, an array or a scalar. */
function objectShape(schema: unknown): Record<string, unknown> | undefined {
  const inner = unwrap(schema);
  if (!(inner instanceof z.ZodObject)) return undefined;
  return inner.shape as Record<string, unknown>;
}

interface ConfigKey {
  readonly section?: string;
  readonly key: string;
}

/**
 * Top-level and section keys named in the page's YAML blocks. A commented key (`# active_hours:`)
 * is still a key the page is teaching, so the comment marker is stripped before the indent is
 * measured; a list item is not a key and is dropped. Only two levels are asserted, because the
 * third is inside records (`model_overrides`) and arrays (`memory.blocks`, `policy.rules`) whose
 * member names are the user's own.
 */
function configKeys(markdown: string): ConfigKey[] {
  const keys: ConfigKey[] = [];
  for (const block of fencedBlocks(withoutNotYetSections(markdown), ["yaml", "yml"])) {
    let section: string | undefined;
    for (const raw of block.split("\n")) {
      const line = raw.replace(/^(\s*)#\s?/, "$1").replace(/\s+$/, "");
      if (line === "" || /^\s*-/.test(line)) continue;
      const entry = /^(\s*)([A-Za-z_][A-Za-z0-9_.-]*):(?:\s|$)/.exec(line);
      if (entry === null) continue;
      const indent = entry[1]!.length;
      const key = entry[2]!;
      if (indent === 0) {
        section = key;
        keys.push({ key });
      } else if (indent === 2 && section !== undefined) {
        keys.push({ section, key });
      }
    }
  }
  return keys;
}

// ── the REPL vocabulary ───────────────────────────────────────────────────────

/**
 * Slash commands named in prose, taken from inline code spans only. A path (`/usr/local/bin/...`,
 * `/v1/models`) is rejected because the name must be followed by whitespace or the end of the
 * span, which is what separates a command from the first segment of a path.
 */
function slashCommands(markdown: string): string[] {
  const names: string[] = [];
  const prose = withoutFences(withoutNotYetSections(markdown));
  for (const span of prose.matchAll(/`([^`\n]+)`/g)) {
    const command = /^\/([a-z][a-z0-9_-]*)(?:\s|$)/.exec(span[1]!);
    if (command !== null) names.push(command[1]!);
  }
  return names;
}

// ── the suites ────────────────────────────────────────────────────────────────

describe("the documents name commands the registry has", () => {
  const found = DOCUMENTS.flatMap((page) => invocations(page, read(page)));

  it("finds invocations in every document", () => {
    for (const page of DOCUMENTS) {
      expect(found.filter((entry) => entry.page === page).length).toBeGreaterThan(0);
    }
  });

  it("resolves every documented command", () => {
    const unknown = found
      .filter((entry) => findSpec(COMMAND_SPECS, entry.command) === undefined)
      .map((entry) => `${entry.page}: trent ${entry.command}`);
    expect([...new Set(unknown)]).toEqual([]);
  });

  it("resolves every documented subcommand", () => {
    const unknown: string[] = [];
    for (const entry of found) {
      if (entry.sub === undefined) continue;
      const parent = findSpec(COMMAND_SPECS, entry.command);
      // A command with no subcommand table takes arguments there instead; nothing to resolve.
      if (parent?.subcommands === undefined) continue;
      if (findSpec(parent.subcommands, entry.sub) === undefined) {
        unknown.push(`${entry.page}: trent ${entry.command} ${entry.sub}`);
      }
    }
    expect([...new Set(unknown)]).toEqual([]);
  });

  it("states the command counts the registry actually has", () => {
    const claim = /(\d+)\s+commands,\s*(\d+)\s+with their subcommands/.exec(read("README.md"));
    expect(claim, "README must state the command count").not.toBeNull();
    expect([Number(claim![1]), Number(claim![2])]).toEqual([
      COMMAND_SPECS.filter((spec) => spec.hidden !== true).length,
      countSpecs(COMMAND_SPECS, false),
    ]);
  });
});

describe("the documents name config keys the schema has", () => {
  const found = configKeys(read("docs/configuration.md"));

  it("finds keys in the configuration page", () => {
    expect(found.length).toBeGreaterThan(20);
  });

  it("resolves every top-level key", () => {
    const shape = TrentConfigSchema.shape as Record<string, unknown>;
    const unknown = found
      .filter((entry) => entry.section === undefined && !(entry.key in shape))
      .map((entry) => `docs/configuration.md: ${entry.key}`);
    expect([...new Set(unknown)]).toEqual([]);
  });

  it("resolves every key named under a section", () => {
    const shape = TrentConfigSchema.shape as Record<string, unknown>;
    const unknown: string[] = [];
    for (const entry of found) {
      if (entry.section === undefined) continue;
      const sectionShape = objectShape(shape[entry.section]);
      // A record or an array holds the user's own names; only an object has a fixed key set.
      if (sectionShape === undefined) continue;
      if (!(entry.key in sectionShape)) unknown.push(`docs/configuration.md: ${entry.section}.${entry.key}`);
    }
    expect([...new Set(unknown)]).toEqual([]);
  });

  it("documents every top-level key the schema carries", () => {
    const documented = new Set(found.filter((entry) => entry.section === undefined).map((entry) => entry.key));
    const missing = Object.keys(TrentConfigSchema.shape).filter((key) => !documented.has(key));
    expect(missing).toEqual([]);
  });
});

describe("the documents name slash commands the REPL registers", () => {
  // `/stop` is handled by the engine before the command table is consulted, so the vocabulary is
  // the table plus that one constant — imported, never spelled out here.
  const registered = new Set([...commandNames(), STOP_COMMAND.replace(/^\//, "")]);

  it("finds slash commands in the documents", () => {
    expect(DOCUMENTS.flatMap((page) => slashCommands(read(page))).length).toBeGreaterThan(0);
  });

  it("resolves every documented slash command", () => {
    const unknown: string[] = [];
    for (const page of DOCUMENTS) {
      for (const name of slashCommands(read(page))) {
        if (!registered.has(name)) unknown.push(`${page}: /${name}`);
      }
    }
    expect([...new Set(unknown)]).toEqual([]);
  });
});

describe("the documents state the doctor's real check count", () => {
  it("counts the checks the runner would run", () => {
    const wrong: string[] = [];
    for (const { page, fencesAreClaims } of DOCTOR_COUNT_PAGES) {
      const text = fencesAreClaims ? read(page) : withoutFences(read(page));
      for (const claim of text.matchAll(/\b(\d+)\s+(?:health\s+)?checks\b/g)) {
        if (Number(claim[1]) !== DEFAULT_CHECKS.length) wrong.push(`${page}: "${claim[0]}"`);
      }
    }
    expect(wrong).toEqual([]);
  });
});

/**
 * Pages that state which names `toolsets` accepts and what a config without the key gets. README
 * joined once its "thirteen" was corrected (P2-5a reported the line; P2-B fixed it).
 */
const TOOLSET_PAGES: readonly string[] = ["README.md", "docs/getting-started.md"];

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];

/** `sixteen` or `16` as a number; NaN for anything else. */
function countWord(word: string): number {
  return /^\d+$/.test(word) ? Number(word) : NUMBER_WORDS.indexOf(word.toLowerCase()) === -1 ? Number.NaN : NUMBER_WORDS.indexOf(word.toLowerCase());
}

const codeNames = (text: string): string[] => [...text.matchAll(/`([a-z_]+)`/g)].map((match) => match[1]!);

describe("the documents state the toolsets the schema accepts", () => {
  it("list every ToolsetSchema name with its count, and what a config with no toolsets key gets", () => {
    for (const page of TOOLSET_PAGES) {
      const prose = withoutFences(read(page)).replace(/\s+/g, " ");
      const accepts = /accepts (\w+) names: ([^.]*)\./.exec(prose);
      expect(accepts, `${page} must say how many names toolsets accepts, and list them`).not.toBeNull();
      expect(countWord(accepts![1]!), `${page}: "accepts ${accepts![1]} names"`).toBe(ToolsetSchema.options.length);
      expect(codeNames(accepts![2]!), page).toEqual([...ToolsetSchema.options]);
      const defaults = /no `toolsets` key gets (\w+) of them\W+everything except ([^.]*)\./.exec(prose);
      expect(defaults, `${page} must say what a config with no toolsets key gets`).not.toBeNull();
      expect(countWord(defaults![1]!), `${page}: "gets ${defaults![1]} of them"`).toBe(DEFAULT_CONFIG.toolsets.length);
      const off = ToolsetSchema.options.filter((name) => !(DEFAULT_CONFIG.toolsets as readonly string[]).includes(name));
      expect(codeNames(defaults![2]!).sort(), page).toEqual([...off].sort());
    }
  });
});
