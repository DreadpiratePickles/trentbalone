/**
 * D10 — every threat the security documents name is mapped to a named, present test, or says
 * plainly that it has none.
 *
 * The LLM Council (02_plan/output/security-council-verdict-2026-09-26.md, D10) asked for coverage to
 * be a build artefact rather than a claim in a plan doc. `docs/security-threat-map.json` is that
 * artefact: one entry per threat, a status, the tests that prove the mitigated part, and a one-line
 * residual for whatever is not proven. This file fails CI when:
 * - a threat ID written in a threat-model document has no entry in the map;
 * - an entry's status is not one of the five known statuses;
 * - a `mitigated` or `partial` entry names no test;
 * - a named test file does not exist, or no `it`/`test`/`describe` title in it contains the name;
 * - an entry that is not fully mitigated carries no residual note;
 * - the status counts printed in docs/security.md ("Threat → test map") differ from the map.
 *
 * The IDs are read out of the documents at run time, so a threat added to the model is uncovered
 * (and red) the day it is written. AGENTS.md invariant 5: no claim without something executable.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const MAP_PATH = "docs/security-threat-map.json";
const SECURITY_PAGE = "docs/security.md";
const SECTION_HEADING = "## Threat → test map";
const FRAMING = "defense-in-depth with stated residuals and per-property proofs";

const STATUSES = ["mitigated", "partial", "residual", "out-of-scope", "founder-gated"] as const;
type Status = (typeof STATUSES)[number];
/** A status that claims something is proven must name the test that proves it. */
const NEEDS_TESTS: ReadonlySet<Status> = new Set<Status>(["mitigated", "partial"]);

/**
 * Where threat IDs are defined, and how each document spells them. The red-team review numbers its
 * findings "**Break N"; the map calls those RT-NN. The public-record survey names the OWASP LLM Top 10.
 */
const THREAT_SOURCES: readonly { readonly doc: string; readonly pattern: RegExp; readonly id: (m: RegExpMatchArray) => string }[] = [
  { doc: "02_plan/output/security-hardening-plan-2026-09-26.md", pattern: /\bT-(\d{2})\b/g, id: (m) => `T-${m[1]}` },
  { doc: "01_discovery/output/security-offline-completeness-2026-09-26.md", pattern: /\bO-(\d{2})\b/g, id: (m) => `O-${m[1]}` },
  { doc: "02_plan/output/security-council-redteam-2026-09-26.md", pattern: /\*\*Break (\d+)\b/g, id: (m) => `RT-${m[1]!.padStart(2, "0")}` },
  { doc: "01_discovery/output/security-public-record-2026-09-26.md", pattern: /\bLLM(0[1-9]|10)\b/g, id: (m) => `OWASP-LLM${m[1]}` },
];

interface TestRef {
  readonly file: string;
  readonly name: string;
}
interface Threat {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly tests: readonly TestRef[];
  readonly residual?: string;
}

function read(relative: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relative), "utf8");
}

function loadMap(): readonly Threat[] {
  const parsed = JSON.parse(read(MAP_PATH)) as { threats?: unknown };
  if (!Array.isArray(parsed.threats)) throw new Error(`${MAP_PATH} has no "threats" array`);
  return parsed.threats as Threat[];
}

/** Every ID the threat-model documents define, in document order, deduplicated. */
function documentedIds(): string[] {
  const ids = new Set<string>();
  for (const source of THREAT_SOURCES) {
    for (const m of read(source.doc).matchAll(source.pattern)) ids.add(source.id(m));
  }
  return [...ids];
}

/**
 * The titles of every `it`/`test`/`describe` in a test file, including modifier chains such as
 * `it.each(rows)(...)` or `describe.skipIf(!docker)(...)`, and titles written across a line break.
 */
function testTitles(source: string): string[] {
  const call = /\b(?:it|test|describe)(?:\.[A-Za-z]+(?:\((?:[^()]|\([^()]*\))*\))?)*\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
  return [...source.matchAll(call)].map((m) => m[2]!);
}

const titleCache = new Map<string, string[]>();
function titlesOf(file: string): string[] {
  let titles = titleCache.get(file);
  if (!titles) {
    titles = testTitles(read(file));
    titleCache.set(file, titles);
  }
  return titles;
}

function countByStatus(threats: readonly Threat[]): Record<Status, number> {
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;
  for (const t of threats) if ((STATUSES as readonly string[]).includes(t.status)) counts[t.status as Status] += 1;
  return counts;
}

/** The `## Threat → test map` section of docs/security.md, up to the next `## ` heading. */
function mapSection(): string {
  const page = read(SECURITY_PAGE);
  const start = page.indexOf(`\n${SECTION_HEADING}\n`);
  if (start < 0) return "";
  const rest = page.slice(start + 1);
  const next = rest.indexOf("\n## ", SECTION_HEADING.length);
  return next < 0 ? rest : rest.slice(0, next);
}

describe("[D10] the title reader finds the titles a mapping names", () => {
  it("reads plain, modifier-chained, template and line-broken titles, and nothing that is not a test", () => {
    const src = [
      'describe("a plain describe", () => {',
      "  it.each([[1], [2]])(`a template ${n} title`, () => {});",
      "  describe.skipIf(!ok())('a skipIf title', () => {});",
      "  it(",
      '    "a title on the next line",',
      "  );",
      '  const itx = "not a test";',
      '  expect(fn("not a title either"));',
    ].join("\n");
    expect(testTitles(src)).toEqual(["a plain describe", "a template ${n} title", "a skipIf title", "a title on the next line"]);
  });
});

describe("[D10] the threat map is well-formed", () => {
  const threats = loadMap();

  it("gives every entry a unique id and a title", () => {
    const ids = threats.map((t) => t.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    expect(threats.filter((t) => typeof t.title !== "string" || t.title.trim() === "").map((t) => t.id)).toEqual([]);
  });

  it("uses only the five known statuses", () => {
    const unknown = threats.filter((t) => !(STATUSES as readonly string[]).includes(t.status)).map((t) => `${t.id}: ${String(t.status)}`);
    expect(unknown).toEqual([]);
  });

  it("gives every tests entry a file and a non-empty name", () => {
    const bad = threats.flatMap((t) =>
      (Array.isArray(t.tests) ? t.tests : [{ file: "", name: "" }])
        .filter((r) => typeof r?.file !== "string" || r.file === "" || typeof r?.name !== "string" || r.name.trim() === "")
        .map(() => t.id),
    );
    expect(bad).toEqual([]);
  });
});

describe("[D10] every documented threat is mapped", () => {
  const threats = loadMap();
  const mapped = new Set(threats.map((t) => t.id));

  it("reads a threat ID out of every threat-model document", () => {
    for (const source of THREAT_SOURCES) {
      expect([...read(source.doc).matchAll(source.pattern)].length, source.doc).toBeGreaterThan(0);
    }
  });

  it("has an entry for every T-, O-, red-team and OWASP LLM ID the documents define", () => {
    expect(documentedIds().filter((id) => !mapped.has(id))).toEqual([]);
  });
});

describe("[D10] every mapped test is named and present", () => {
  const threats = loadMap();

  it("a mitigated or partial entry names at least one test", () => {
    const bare = threats.filter((t) => NEEDS_TESTS.has(t.status as Status) && (t.tests ?? []).length === 0).map((t) => t.id);
    expect(bare).toEqual([]);
  });

  it("every named test file exists", () => {
    const missing = threats.flatMap((t) => (t.tests ?? []).filter((r) => !fs.existsSync(path.join(REPO_ROOT, r.file))).map((r) => `${t.id}: ${r.file}`));
    expect(missing).toEqual([]);
  });

  it("every named test is an it/test/describe title in that file", () => {
    const absent = threats.flatMap((t) =>
      (t.tests ?? [])
        .filter((r) => fs.existsSync(path.join(REPO_ROOT, r.file)))
        .filter((r) => !titlesOf(r.file).some((title) => title.includes(r.name)))
        .map((r) => `${t.id}: ${r.file} :: ${r.name}`),
    );
    expect(absent).toEqual([]);
  });

  it("an entry that is not fully mitigated says what remains, in one line", () => {
    const silent = threats
      .filter((t) => t.status !== "mitigated")
      .filter((t) => typeof t.residual !== "string" || t.residual.trim() === "" || t.residual.includes("\n"))
      .map((t) => t.id);
    expect(silent).toEqual([]);
  });
});

describe("[D10] docs/security.md prints the map's counts and its framing", () => {
  const threats = loadMap();
  const section = mapSection();

  it("has a Threat → test map section that points at the map and states the framing", () => {
    expect(section, `${SECURITY_PAGE} has no "${SECTION_HEADING}" section`).not.toBe("");
    expect(section).toContain(MAP_PATH);
    expect(section).toContain(FRAMING);
  });

  it("prints each status count and the total exactly as the map has them", () => {
    const printed: Record<string, number> = {};
    for (const m of section.matchAll(/^\|\s*`?([a-z-]+)`?\s*\|\s*(\d+)\s*\|/gm)) printed[m[1]!] = Number(m[2]);
    const counts = countByStatus(threats);
    expect(printed).toEqual({ ...counts, total: threats.length });
  });
});
