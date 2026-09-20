import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigManager } from "../../config/ConfigManager.js";
import type { DoctorContext } from "../types.js";
import { checkSkills, WORKSPACE_SKILLS_DIR } from "./skills.js";

let home: string;
let workspace: string;

const context = (): DoctorContext => ({
  baseDir: home,
  profile: "default",
  configManager: new ConfigManager({ baseDir: home }),
});

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-doctor-skills-home-"));
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "trent-doctor-skills-cwd-"));
  vi.spyOn(process, "cwd").mockReturnValue(workspace);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
});

/**
 * The app reads a seat's granted skills from `<cwd>/.claude/skills`. A workspace without that
 * directory runs its seats without those instructions (the loader treats it as zero skills);
 * the doctor is where that is said, once, so the silence is not mistaken for a full prompt.
 */
describe("check_skills and the workspace's .claude/skills", () => {
  it("notes a workspace without .claude/skills: the seats run without their granted skill instructions", async () => {
    const result = await checkSkills.run(context());

    expect(result.status).toBe("ok");
    expect(result.message).toContain(`no ${WORKSPACE_SKILLS_DIR}`);
    expect(result.message).toContain("granted skill instructions");
    expect(result.details).toMatchObject({ workspaceSkills: { present: false, dir: path.join(workspace, WORKSPACE_SKILLS_DIR) } });
  });

  it("says how many workspace skills the seats can load when the directory is there", async () => {
    fs.mkdirSync(path.join(workspace, WORKSPACE_SKILLS_DIR, "prd"), { recursive: true });
    fs.mkdirSync(path.join(workspace, WORKSPACE_SKILLS_DIR, "copywriting"), { recursive: true });

    const result = await checkSkills.run(context());

    expect(result.status).toBe("ok");
    expect(result.message).not.toContain(`no ${WORKSPACE_SKILLS_DIR}`);
    expect(result.details).toMatchObject({ workspaceSkills: { present: true, count: 2 } });
  });
});
