/**
 * One skill store: the canonical directory form, and the migration that converts the legacy flat
 * form to it on first read. Both surfaces (`trent skills` and the `skills` toolset) go through
 * this module, so these are the tests that pin the on-disk format.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_SKILL_STATUS,
  SKILL_DIR_MODE,
  SKILL_FILE,
  SKILL_FILE_MODE,
  findSkillRecord,
  listSkillRecords,
  listAdvertisedSkillRecords,
  parseFrontmatter,
  removeSkillRecord,
  writeSkillRecord,
} from "./skill-store.js";
import { SkillLoader } from "./SkillLoader.js";
import { USAGE_FILE, readSkillUsage } from "./usage.js";

let skillsDir: string;
let lines: string[];

const sink = () => ({ onMigrate: (line: string) => lines.push(line) });
const mode = (p: string) => fs.statSync(p).mode & 0o777;

beforeEach(() => {
  skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-skill-store-"));
  lines = [];
});

afterEach(() => {
  fs.rmSync(skillsDir, { recursive: true, force: true });
});

describe("skill store: canonical form", () => {
  it("writes <skills>/<category>/<name>/SKILL.md with frontmatter, 0600 files under 0700 dirs", () => {
    const file = writeSkillRecord(skillsDir, {
      name: "release-notes",
      title: "Release notes",
      description: "Draft release notes from merged pull requests",
      category: "engineering",
      trust: "trusted",
      version: "1.2.0",
      author: "bobby",
      tags: ["release", "docs"],
      instructions: "Collect merged pull requests and summarise them.",
    });
    expect(file).toBe(path.join(skillsDir, "engineering", "release-notes", SKILL_FILE));
    expect(mode(file)).toBe(SKILL_FILE_MODE);
    expect(mode(path.dirname(file))).toBe(SKILL_DIR_MODE);

    const record = findSkillRecord(skillsDir, "release-notes", sink());
    expect(record).not.toBeNull();
    expect(record).toMatchObject({
      name: "release-notes",
      title: "Release notes",
      description: "Draft release notes from merged pull requests",
      category: "engineering",
      trust: "trusted",
      version: "1.2.0",
      author: "bobby",
      tags: ["release", "docs"],
    });
    expect(record!.dir).toBe(path.dirname(file));
    expect(record!.instructions.trim()).toBe("Collect merged pull requests and summarise them.");

    expect(removeSkillRecord(skillsDir, "release-notes")).toBe(true);
    expect(listSkillRecords(skillsDir, sink())).toEqual([]);
    expect(removeSkillRecord(skillsDir, "release-notes")).toBe(false);
  });
});

describe("skill store: migration of the flat form", () => {
  it("converts a flat markdown skill and a flat json skill on first read, once, naming each", () => {
    fs.writeFileSync(
      path.join(skillsDir, "repo-audit.md"),
      "# Repository Audit\n> Deep codebase mapping and dependency graph.\n\nAnalyze package dependencies.\n",
    );
    fs.writeFileSync(
      path.join(skillsDir, "runway.json"),
      JSON.stringify({
        name: "Financial Runway Forecast",
        description: "Burn rate and runway months.",
        version: "2.1.0",
        tags: ["finance", "cashflow"],
        author: "bobby",
        instructions: "Project revenue, variable costs and runway.",
      }),
    );

    const first = listSkillRecords(skillsDir, sink());
    expect(first.map((r) => r.name)).toEqual(["repo-audit", "runway"]);

    const audit = first[0]!;
    expect(audit.dir).toBe(path.join(skillsDir, "repo-audit"));
    expect(audit.file).toBe(path.join(skillsDir, "repo-audit", SKILL_FILE));
    expect(audit.title).toBe("Repository Audit");
    expect(audit.description).toBe("Deep codebase mapping and dependency graph.");
    expect(audit.instructions).toContain("Analyze package dependencies.");
    expect(audit.trust).toBe("trusted");
    expect(mode(audit.file)).toBe(SKILL_FILE_MODE);
    expect(fs.existsSync(path.join(skillsDir, "repo-audit.md"))).toBe(false);

    const runway = first[1]!;
    expect(runway.file).toBe(path.join(skillsDir, "finance", "runway", SKILL_FILE));
    expect(runway.title).toBe("Financial Runway Forecast");
    expect(runway.version).toBe("2.1.0");
    expect(runway.author).toBe("bobby");
    expect(runway.tags).toEqual(["finance", "cashflow"]);
    expect(runway.instructions).toContain("Project revenue");
    expect(fs.existsSync(path.join(skillsDir, "runway.json"))).toBe(false);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("repo-audit");
    expect(lines[1]).toContain("runway");

    // A second read migrates nothing, logs nothing, and rewrites nothing.
    const stamp = fs.statSync(audit.file).mtimeMs;
    lines = [];
    const second = listSkillRecords(skillsDir, sink());
    expect(second.map((r) => r.name)).toEqual(["repo-audit", "runway"]);
    expect(lines).toEqual([]);
    expect(fs.statSync(audit.file).mtimeMs).toBe(stamp);
  });

  // The provisioner writes a bundled SKILL.md verbatim as `<slug>.md`, Agent Skills frontmatter
  // and all. That frontmatter is the skill's own metadata, so the migration has to read it: before
  // this test the store took the description from a stray `> ` line of the body and wrapped the
  // whole document, frontmatter included, inside a second frontmatter.
  it("migrates a flat markdown skill that carries Agent Skills frontmatter with its own metadata and body, once", () => {
    fs.writeFileSync(
      path.join(skillsDir, "quote-estimate.md"),
      [
        "---",
        "name: quote-estimate",
        "description: Turn a site visit into a written quote.",
        "category: small-business",
        "trust: official",
        "version: 1.2.0",
        "author: trent",
        "tags: quotes, pricing",
        "---",
        "# Quote and Estimate",
        "",
        "> A quoted line that is part of the body, not the description.",
        "",
        "Price the job line by line.",
        "",
      ].join("\n"),
    );

    const [record] = listSkillRecords(skillsDir, sink());
    expect(record?.name).toBe("quote-estimate");
    expect(record?.title).toBe("Quote and Estimate");
    expect(record?.description).toBe("Turn a site visit into a written quote.");
    expect(record?.category).toBe("small-business");
    expect(record?.trust).toBe("official");
    expect(record?.version).toBe("1.2.0");
    expect(record?.author).toBe("trent");
    expect(record?.tags).toEqual(["quotes", "pricing"]);
    expect(record?.file).toBe(path.join(skillsDir, "small-business", "quote-estimate", SKILL_FILE));
    expect(record?.instructions).toContain("Price the job line by line.");
    expect(record?.instructions).not.toContain("description: Turn a site visit");

    // Exactly one frontmatter block on disk, and the body starts with the heading.
    const text = fs.readFileSync(record!.file, "utf8");
    expect(text.split("\n---\n").length).toBe(2);
    expect(text).toContain("\n---\n# Quote and Estimate");
    expect(text).toContain("description: Turn a site visit into a written quote.");
    expect(text).not.toContain("name: quote-estimate\n");

    // A flat file that names no frontmatter keeps the heading-and-quote reading it always had.
    const again = listSkillRecords(skillsDir, sink());
    expect(again.map((r) => r.name)).toEqual(["quote-estimate"]);
    expect(lines).toHaveLength(1);
  });

  // The app bundle quotes some descriptions the YAML way (`description: "When the user..."`); a
  // quoted scalar is its content, not its quote marks.
  it("reads a quoted frontmatter scalar without its quote marks", () => {
    expect(parseFrontmatter('---\ndescription: "Paid ads, quoted."\nauthor: \'trent\'\n---\nBody.\n').fields).toEqual({
      description: "Paid ads, quoted.",
      author: "trent",
    });
    expect(parseFrontmatter("---\ndescription: unquoted: with a colon\n---\n").fields.description).toBe("unquoted: with a colon");
  });

  it("never overwrites an existing canonical skill and never drops a name it cannot migrate", () => {
    writeSkillRecord(skillsDir, {
      name: "repo-audit",
      title: "Repository Audit",
      description: "The edited one.",
      category: "general",
      trust: "trusted",
      instructions: "Edited by the agent.",
    });
    fs.writeFileSync(path.join(skillsDir, "repo-audit.md"), "# Repository Audit\n\nThe stale flat one.\n");
    fs.writeFileSync(path.join(skillsDir, "Legacy.Skill.md"), "# Legacy\n> Kept as it is.\n\nBody.\n");

    const records = listSkillRecords(skillsDir, sink());
    expect(records.map((r) => r.name)).toEqual(["Legacy.Skill", "repo-audit"]);

    const audit = records.find((r) => r.name === "repo-audit")!;
    expect(audit.instructions).toContain("Edited by the agent.");
    expect(audit.instructions).not.toContain("stale flat one");
    expect(lines).toEqual([]);

    const legacy = records.find((r) => r.name === "Legacy.Skill")!;
    expect(legacy.dir).toBeNull();
    expect(legacy.file).toBe(path.join(skillsDir, "Legacy.Skill.md"));
    expect(legacy.instructions).toContain("Body.");
    expect(fs.existsSync(path.join(skillsDir, "Legacy.Skill.md"))).toBe(true);
  });
});

describe("skill store: the curator's lifecycle fields [D3]", () => {
  it("round-trips status, provenance and promoted_at through the frontmatter", () => {
    writeSkillRecord(skillsDir, {
      name: "sprint-report",
      description: "Summarise the sprint",
      instructions: "# Sprint report\nList what shipped.",
      status: "stale",
      createdBy: "agent",
      promotedAt: "2026-01-02T03:04:05.000Z",
    });

    const record = findSkillRecord(skillsDir, "sprint-report");

    expect(record?.status).toBe("stale");
    expect(record?.createdBy).toBe("agent");
    expect(record?.promotedAt).toBe("2026-01-02T03:04:05.000Z");
    expect(record?.quarantineReason).toBeNull();
    expect(fs.readFileSync(record!.file, "utf8")).toContain("created_by: agent");
  });

  it("a skill that declares nothing is active and the founder's, so the curator leaves it alone", () => {
    const dir = path.join(skillsDir, "hand-written");
    fs.mkdirSync(dir, { recursive: true, mode: SKILL_DIR_MODE });
    fs.writeFileSync(path.join(dir, SKILL_FILE), "---\nname: Hand written\n---\n# Hand written\nDo it by hand.\n", { mode: SKILL_FILE_MODE });

    const record = findSkillRecord(skillsDir, "hand-written");

    expect(record?.status).toBe(DEFAULT_SKILL_STATUS);
    expect(record?.createdBy).toBe("human");
  });

  it("the curator's dot entries are metadata, never skills", () => {
    writeSkillRecord(skillsDir, { name: "real-skill", instructions: "# Real skill\nDo the thing." });
    fs.writeFileSync(path.join(skillsDir, USAGE_FILE), '{"real-skill":{"use_count":2}}\n', { mode: SKILL_FILE_MODE });
    fs.writeFileSync(path.join(skillsDir, ".ledger.ndjson"), "{}\n", { mode: SKILL_FILE_MODE });
    fs.mkdirSync(path.join(skillsDir, ".blobs"), { recursive: true, mode: SKILL_DIR_MODE });

    expect(listSkillRecords(skillsDir, sink()).map((s) => s.name)).toEqual(["real-skill"]);
    expect(lines).toEqual([]);
  });

  it("loading a skill counts the load; an archived skill is still readable but not advertised", () => {
    writeSkillRecord(skillsDir, { name: "weekly-metrics", instructions: "# Weekly metrics\nPull the numbers.", createdBy: "agent" });
    const loader = new SkillLoader(skillsDir);

    const loaded = loader.loadFull("weekly-metrics", { now: "2026-09-18T00:00:00.000Z" });

    expect(loaded.useCount).toBe(1);
    expect(loaded.lastUsedAt).toBe("2026-09-18T00:00:00.000Z");
    expect(readSkillUsage(skillsDir).get("weekly-metrics")?.useCount).toBe(1);
    expect(findSkillRecord(skillsDir, "weekly-metrics")?.useCount).toBe(1);

    writeSkillRecord(skillsDir, { name: "weekly-metrics", instructions: "# Weekly metrics\nPull the numbers.", createdBy: "agent", status: "archived" });
    expect(listAdvertisedSkillRecords(skillsDir).map((s) => s.name)).toEqual([]);
    expect(findSkillRecord(skillsDir, "weekly-metrics")?.instructions).toContain("Pull the numbers");
  });
});
