/**
 * B0.2 — `trent skills` and the `skills` toolset are one store. A skill the CLI installs is
 * editable by `skill_manage`; a skill the agent authors is listed and viewable by the CLI; a
 * legacy flat file is migrated once and never twice.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EXIT } from "@trent/core/errors/index.js";
import { createSkillsAdapter } from "@trent/core/tools/skills/index.js";
import { runCli } from "../index.js";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-skills-"));
  process.env.TRENT_HOME = home;
});

afterEach(() => {
  delete process.env.TRENT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

const manage = (ops: unknown[]) =>
  createSkillsAdapter({ profileDir: home }).execute(`skill_manage ${JSON.stringify({ operations: ops })}`, {});

async function json<T>(argv: readonly string[]): Promise<T> {
  const result = await runCli([...argv, "--json"]);
  expect(result.exitCode, result.stderr).toBe(EXIT.OK);
  return JSON.parse(result.stdout) as T;
}

describe("trent skills and the skills toolset share one store", () => {
  it("a CLI-installed skill is edited by skill_manage and the edit is what skills view prints", async () => {
    const installed = await json<{ slug: string }>(["skills", "install", "repo-audit"]);
    expect(installed.slug).toBe("repo-audit");

    const patched = await manage([
      { action: "patch", name: "repo-audit", old_string: "Analyze", new_string: "Map" },
    ]);
    expect(patched.status, patched.summary).toBe("completed");

    const viewed = await json<{ slug: string; instructions: string }>(["skills", "view", "repo-audit"]);
    expect(viewed.instructions).toContain("Map package dependencies");
    expect(viewed.instructions).not.toContain("Analyze package dependencies");

    const listed = await json<{ skills: { slug: string }[] }>(["skills", "list"]);
    expect(listed.skills.map((s) => s.slug)).toEqual(["repo-audit"]);
  });

  it("a skill the agent authors through skill_manage is listed and viewable by the CLI", async () => {
    const created = await manage([
      {
        action: "create",
        name: "standup-notes",
        category: "growth",
        description: "Turn a run transcript into standup notes",
        content: "# Standup notes\n> Turn a run transcript into standup notes\n\nList what shipped and what is blocked.",
      },
    ]);
    expect(created.status, created.summary).toBe("completed");

    const listed = await json<{ count: number; skills: { slug: string; description: string }[] }>(["skills", "list"]);
    expect(listed.skills.map((s) => s.slug)).toContain("standup-notes");
    expect(listed.skills.find((s) => s.slug === "standup-notes")?.description).toContain("standup notes");

    const viewed = await json<{ instructions: string; category: string }>(["skills", "view", "standup-notes"]);
    expect(viewed.instructions).toContain("List what shipped");

    const missing = await runCli(["skills", "view", "no-such-skill", "--json"]);
    expect(missing.exitCode).toBe(EXIT.CONFIG);
  });

  it("migrates a legacy flat skill once; a second listing changes nothing on disk", async () => {
    const skillsDir = path.join(home, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(skillsDir, "pr-reviewer.md"), "# PR reviewer\n> Reviews diffs.\n\nCheck edge cases.\n");

    const first = await json<{ skills: { slug: string }[] }>(["skills", "list"]);
    expect(first.skills.map((s) => s.slug)).toEqual(["pr-reviewer"]);
    const canonical = path.join(skillsDir, "pr-reviewer", "SKILL.md");
    expect(fs.existsSync(canonical)).toBe(true);
    expect(fs.existsSync(path.join(skillsDir, "pr-reviewer.md"))).toBe(false);
    const stamp = fs.statSync(canonical).mtimeMs;

    const second = await json<{ skills: { slug: string }[] }>(["skills", "list"]);
    expect(second.skills.map((s) => s.slug)).toEqual(["pr-reviewer"]);
    expect(fs.statSync(canonical).mtimeMs).toBe(stamp);

    const removed = await runCli(["skills", "remove", "pr-reviewer", "--json"]);
    expect(removed.exitCode).toBe(EXIT.OK);
    expect(fs.existsSync(path.join(skillsDir, "pr-reviewer"))).toBe(false);
  });
});
