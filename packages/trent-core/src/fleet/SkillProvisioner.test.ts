/**
 * Two skill sources, one lookup. The app bundle (`apps/web/.agents/skills`, read-only) and the
 * core source (`packages/trent-core/skills`, the one place a skill the app cannot carry lives) are
 * read in that order, so on a name collision the app's copy wins and nothing in core can shadow
 * a skill the catalog already refers to.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SecurityScan } from "../skills/SecurityScan.js";
import { SKILL_NAME_PATTERN, parseFrontmatter } from "../skills/skill-store.js";
import {
  BUNDLED_SKILLS_DIR,
  CORE_SKILLS_DIR,
  DEFAULT_SKILL_SOURCE_DIRS,
  SkillProvisioner,
  createLayeredSkillSource,
  listSourceSkills,
} from "./SkillProvisioner.js";

/** Every frontmatter field the Agent Skills layout carries in this repository. */
const REQUIRED_FIELDS = ["name", "description", "category", "trust", "version", "author", "tags"] as const;

function skill(root: string, name: string, body: string): void {
  fs.mkdirSync(path.join(root, name), { recursive: true });
  fs.writeFileSync(path.join(root, name, "SKILL.md"), body, "utf8");
}

describe("the core skill source", () => {
  it("sits at packages/trent-core/skills and is read after the app bundle", () => {
    expect(CORE_SKILLS_DIR).toBe(path.resolve(BUNDLED_SKILLS_DIR, "../../../..", "packages/trent-core/skills"));
    expect(fs.existsSync(CORE_SKILLS_DIR)).toBe(true);
    expect(DEFAULT_SKILL_SOURCE_DIRS).toEqual([BUNDLED_SKILLS_DIR, CORE_SKILLS_DIR]);
  });

  it("lists skills from both sources, each with the root it came from", () => {
    const listed = listSourceSkills();
    const byName = new Map(listed.map((entry) => [entry.name, entry]));
    expect(byName.get("customer-escalation")?.root).toBe(BUNDLED_SKILLS_DIR);
    expect(byName.get("quote-estimate")?.root).toBe(CORE_SKILLS_DIR);
    // Sorted, and one entry per name.
    expect(listed.map((entry) => entry.name)).toEqual([...new Set(listed.map((entry) => entry.name))].sort());
  });

  it("every core skill is a well-formed SKILL.md: all seven fields, the directory name as its name, and clean under the scan", () => {
    const core = listSourceSkills([CORE_SKILLS_DIR]);
    expect(core.length).toBeGreaterThan(0);
    for (const entry of core) {
      expect(SKILL_NAME_PATTERN.test(entry.name), entry.name).toBe(true);
      const text = fs.readFileSync(entry.file, "utf8");
      const { fields, body } = parseFrontmatter(text);
      for (const field of REQUIRED_FIELDS) {
        expect(fields[field]?.length ?? 0, `${entry.name} is missing ${field}`).toBeGreaterThan(0);
      }
      expect(fields.name, entry.name).toBe(entry.name);
      expect(SecurityScan.scan(text).safe, entry.name).toBe(true);
      // A skill is Markdown a seat follows: a heading, a section a seat can read as the output format.
      expect(body).toMatch(/^# /m);
      expect(body.toLowerCase()).toContain("output");
    }
  });

  /**
   * Decision 4 (2026-09-20): the creator skills call the media tools by name with the arguments
   * a seat must pass, and each still carries an output section and passes the scan. `clip-plan`
   * turns a long recording into a ranked list of clip candidates, each with its `media_clip` call.
   */
  it("the creator skills name the media tools they call, with the arguments, and clip-plan lists every candidate's media_clip call", () => {
    const core = new Map(listSourceSkills([CORE_SKILLS_DIR]).map((entry) => [entry.name, entry]));
    const expected: Record<string, readonly string[]> = {
      "hook-lab": ["media_probe", "media_transcribe", "media_thumbnail", "media_clip"],
      "caption-and-chapters": ["media_probe", "media_transcribe", "media_clip"],
      "repurpose-plan": ["media_probe", "media_transcribe", "media_scenes", "media_clip"],
      "clip-plan": ["media_probe", "media_transcribe", "media_scenes", "media_clip", "media_thumbnail", "media_image"],
      "thumbnail-brief": ["media_thumbnail", "media_image"],
    };
    for (const [name, tools] of Object.entries(expected)) {
      const entry = core.get(name);
      expect(entry, `${name} is not in the core source`).toBeDefined();
      const text = fs.readFileSync(entry!.file, "utf8");
      const { body } = parseFrontmatter(text);
      for (const tool of tools) expect(body, `${name} never calls ${tool}`).toContain(tool);
      expect(body, `${name} has no output format section`).toMatch(/^## Output format$/m);
      expect(body, `${name} does not say the backend condition`).toContain("when the media backend is installed");
      expect(body, `${name} does not name the doctor line`).toContain("Media Pipeline");
      expect(body, `${name} still defers to a toolset that has landed`).not.toMatch(/until the media toolset lands|when the media toolset lands/i);
      expect(SecurityScan.scan(text).safe, name).toBe(true);
    }
    // The arguments a seat must pass, spelled as the schema names them.
    const clipPlan = parseFrontmatter(fs.readFileSync(core.get("clip-plan")!.file, "utf8")).body;
    for (const arg of ['"input"', '"start"', '"end"', '"crop"', '"captions"']) expect(clipPlan).toContain(arg);
    expect(clipPlan).toMatch(/approv/i);
    expect(clipPlan).toMatch(/cents/);
    const thumbnail = parseFrontmatter(fs.readFileSync(core.get("thumbnail-brief")!.file, "utf8")).body;
    for (const arg of ['"brief"', '"variant"', '"aspect"', '"at"', '"width"']) expect(thumbnail).toContain(arg);
  });

  it("never shadows an app skill: a core skill with the same name is listed and read from the app", () => {
    const app = listSourceSkills([BUNDLED_SKILLS_DIR]).map((entry) => entry.name);
    const core = listSourceSkills([CORE_SKILLS_DIR]).map((entry) => entry.name);
    expect(core.filter((name) => app.includes(name))).toEqual([]);
  });
});

describe("layering two directories", () => {
  let first: string;
  let second: string;

  beforeEach(() => {
    first = fs.mkdtempSync(path.join(os.tmpdir(), "trent-skill-source-a-"));
    second = fs.mkdtempSync(path.join(os.tmpdir(), "trent-skill-source-b-"));
    skill(first, "shared", "# Shared, from the first root\n\nOutput: first.\n");
    skill(second, "shared", "# Shared, from the second root\n\nOutput: second.\n");
    skill(second, "only-second", "# Only in the second root\n\nOutput: second.\n");
  });

  afterEach(() => {
    fs.rmSync(first, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
  });

  it("the first root wins on a collision, the second still supplies what the first lacks", () => {
    const source = createLayeredSkillSource([first, second]);
    expect(source.read("shared")).toContain("from the first root");
    expect(source.read("only-second")).toContain("Only in the second root");
    expect(source.read("absent")).toBeNull();
    expect(source.read("../shared")).toBeNull();

    const listed = listSourceSkills([first, second]);
    expect(listed.map((entry) => [entry.name, entry.root])).toEqual([
      ["only-second", second],
      ["shared", first],
    ]);
    // A root that does not exist is skipped, not an error.
    expect(listSourceSkills([path.join(first, "missing"), second]).map((entry) => entry.name)).toEqual(["only-second", "shared"]);
  });

  it("the provisioner installs from either root and counts a canonical SKILL.md as already present", () => {
    const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-skill-provision-"));
    try {
      const provisioner = new SkillProvisioner(skillsDir, createLayeredSkillSource([first, second]));
      const plan = provisioner.plan(["shared", "only-second", "absent"], "pack:test");
      expect(plan.writes.map((w) => w.slug)).toEqual(["shared", "only-second"]);
      expect(plan.unresolved).toEqual(["absent"]);
      expect(provisioner.commit(plan)).toEqual(["only-second", "shared"]);

      // The store migrates the flat file into <skills>/<slug>/SKILL.md; a reinstall must see it.
      fs.mkdirSync(path.join(skillsDir, "only-second"), { recursive: true });
      fs.renameSync(path.join(skillsDir, "only-second.md"), path.join(skillsDir, "only-second", "SKILL.md"));
      // A categorised skill lives one level deeper: <skills>/<category>/<slug>/SKILL.md.
      fs.mkdirSync(path.join(skillsDir, "small-business", "shared"), { recursive: true });
      fs.renameSync(path.join(skillsDir, "shared.md"), path.join(skillsDir, "small-business", "shared", "SKILL.md"));
      const again = provisioner.plan(["shared", "only-second"], "pack:test");
      expect(again.writes).toEqual([]);
      expect(again.present).toEqual(["shared", "only-second"]);
      expect(fs.existsSync(path.join(skillsDir, "only-second.md"))).toBe(false);
      expect(fs.existsSync(path.join(skillsDir, "shared.md"))).toBe(false);
    } finally {
      fs.rmSync(skillsDir, { recursive: true, force: true });
    }
  });
});
