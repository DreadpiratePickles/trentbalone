/**
 * A workspace without `.claude/skills` is a workspace with no installed skills, not a broken seat.
 *
 * Measured on the compiled CLI from any directory that lacks `.claude/skills`: the first seat step
 * died with `ENOENT ... .claude/skills/gtm-operating-cadence/SKILL.md`, the stream ended "without
 * a verdict" and nothing said why. A granted skill whose SKILL.md is not in the workspace is
 * simply not injected; the caller decides whether that is worth a note.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listInstalledSkillNames, loadGrantedSkillInstructions } from "@/lib/agent-skill-instructions";

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "trent-no-skills-"));
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe("granted skills in a workspace without .claude/skills", () => {
  it("lists zero installed skills instead of throwing ENOENT", async () => {
    await expect(listInstalledSkillNames(path.join(workspace, ".claude/skills"))).resolves.toEqual([]);
  });

  it("loads zero instruction blocks for a granted skill whose SKILL.md is absent", async () => {
    await expect(
      loadGrantedSkillInstructions(["gtm-operating-cadence"], path.join(workspace, ".claude/skills")),
    ).resolves.toEqual([]);
  });

  it("still loads the skills that are present, skipping only the absent ones", async () => {
    const root = path.join(workspace, ".claude/skills");
    fs.mkdirSync(path.join(root, "prd"), { recursive: true });
    fs.writeFileSync(path.join(root, "prd", "SKILL.md"), "---\nname: prd\n---\nWrite the PRD first.\n");

    const blocks = await loadGrantedSkillInstructions(["gtm-operating-cadence", "prd"], root);

    expect(blocks).toEqual(["Skill: prd\nWrite the PRD first."]);
  });

  it("still refuses a skill the vendored map does not know", async () => {
    await expect(loadGrantedSkillInstructions(["missing-skill"], path.join(workspace, ".claude/skills"))).rejects.toThrow(
      "Unknown Agent Plug skill",
    );
  });
});
