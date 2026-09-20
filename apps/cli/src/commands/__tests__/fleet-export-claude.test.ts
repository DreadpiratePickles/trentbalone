/**
 * U5 — `trent fleet export <id|pack> --target claude --out DIR`: the droppable Claude Code (and
 * Grok Build) layout, and the round trip: `fleet import` of what it wrote restores the record with
 * its seat block. Through `runCli` with the injected in-memory improve store and a temporary
 * TRENT_HOME, like the rest of the fleet suite.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EXIT } from "@trent/core/errors/index.js";
import { seatCapability } from "@trent/core/fleet/index.js";
import { InMemoryImproveStore } from "@trent/core/improve/index.js";
import { parseFrontmatter } from "@trent/core/skills/skill-store.js";
import { runCli } from "../index.js";
import { setImproveStoreForTests } from "../improve.js";

let home: string;
const extra: string[] = [];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-fleet-claude-"));
  process.env.TRENT_HOME = home;
  setImproveStoreForTests(new InMemoryImproveStore());
});

afterEach(() => {
  setImproveStoreForTests(undefined);
  delete process.env.TRENT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
  for (const dir of extra.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function outDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `trent-claude-${label}-`));
  extra.push(dir);
  return dir;
}

async function installEngineerWithSkill(): Promise<void> {
  await runCli(["fleet", "install", "engineer", "--json"]);
  fs.writeFileSync(path.join(home, "skills", "repo-audit.md"), "# Repository Audit\n> Map the codebase.\n\nList every package.");
  const record = path.join(home, "agents", "engineer.json");
  const parsed = JSON.parse(fs.readFileSync(record, "utf8")) as { installed_skills: string[] };
  parsed.installed_skills = ["repo-audit"];
  fs.writeFileSync(record, JSON.stringify(parsed, null, 2));
}

describe("trent fleet export --target claude", () => {
  it("writes the subagent file, .mcp.json for this profile and the skills, and reports them", async () => {
    await installEngineerWithSkill();
    const out = outDir("seat");
    const result = await runCli(["fleet", "export", "engineer", "--target", "claude", "--out", out, "--json"]);
    expect(result.exitCode).toBe(EXIT.OK);
    const data = JSON.parse(result.stdout) as { target: string; agents: string[]; files: string[]; persona: boolean; dir: string };
    expect(data.target).toBe("claude");
    expect(data.agents).toEqual(["engineer"]);
    expect(data.dir).toBe(out);
    for (const relative of [".claude/agents/engineer.md", ".mcp.json", "skills/repo-audit/SKILL.md", "agent.json"]) {
      expect(data.files, relative).toContain(relative);
      expect(fs.existsSync(path.join(out, relative)), relative).toBe(true);
    }
    const { fields, body } = parseFrontmatter(fs.readFileSync(path.join(out, ".claude", "agents", "engineer.md"), "utf8"));
    expect(fields.name).toBe("engineer");
    expect(fields.tools).toContain("mcp__trent__terminal");
    expect(body).toContain("trent approvals approve");
    const mcp = JSON.parse(fs.readFileSync(path.join(out, ".mcp.json"), "utf8")) as { mcpServers: { trent: { args: string[] } } };
    expect(mcp.mcpServers.trent.args).toEqual(["mcp", "serve", "--stdio", "--profile", "default"]);
  });

  it("round-trips: fleet import of the exported bundle restores the record with its seat block", async () => {
    await installEngineerWithSkill();
    const out = outDir("round-trip");
    expect((await runCli(["fleet", "export", "engineer", "--target", "claude", "--out", out, "--json"])).exitCode).toBe(EXIT.OK);

    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-fresh-claude-"));
    extra.push(fresh);
    process.env.TRENT_HOME = fresh;
    setImproveStoreForTests(new InMemoryImproveStore());
    const imported = await runCli(["fleet", "import", out, "--json"]);
    expect(imported.exitCode).toBe(EXIT.OK);
    const record = JSON.parse(fs.readFileSync(path.join(fresh, "agents", "engineer.json"), "utf8")) as {
      seat?: { budgetCents: number; toolsets: string[]; approvalGates: string[]; modelTier: string; evalSuiteId: string };
      budget_cap_per_run_cents: number;
      installed_skills: string[];
    };
    const seat = seatCapability("engineer");
    expect(record.seat).toMatchObject({ budgetCents: seat.budgetCents, toolsets: [...seat.toolsets], approvalGates: [...seat.approvalGates], modelTier: seat.modelTier, evalSuiteId: "engineer" });
    expect(record.budget_cap_per_run_cents).toBe(seat.budgetCents);
    expect(record.installed_skills).toEqual(["repo-audit"]);
  });

  it("exports a pack: one subagent per seat member, the persona when the brain holds one", async () => {
    fs.mkdirSync(path.join(home, "brain", "system"), { recursive: true });
    fs.writeFileSync(path.join(home, "brain", "system", "persona-executive.md"), "The executive crew keeps the founder's week honest.\n");
    const out = outDir("pack");
    const result = await runCli(["fleet", "export", "executive", "--target", "claude", "--out", out, "--json"]);
    expect(result.exitCode).toBe(EXIT.OK);
    const data = JSON.parse(result.stdout) as { agents: string[]; persona: boolean; pack?: string };
    expect(data.pack).toBe("executive");
    expect(data.persona).toBe(true);
    expect(data.agents).toEqual(["ceo", "engineer", "growth", "finance"]);
    expect(fs.readFileSync(path.join(out, ".claude", "agents", "finance.md"), "utf8")).toContain("keeps the founder's week honest");
  });

  it("refuses a target it does not render, and --dry-run reports without writing", async () => {
    const out = outDir("refused");
    // [W5] codex and hermes are rendered now; Grok Build reads the Claude layout and has no target of its own.
    const grok = await runCli(["fleet", "export", "engineer", "--target", "grok", "--out", out, "--json"]);
    expect(grok.exitCode).toBe(EXIT.USAGE);
    expect(`${grok.stdout}${grok.stderr}`).toContain("claude");
    const dry = await runCli(["fleet", "export", "engineer", "--target", "claude", "--out", out, "--json", "--dry-run"]);
    expect(dry.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(dry.stdout)).toMatchObject({ dryRun: true, command: "fleet export", target: "claude", agentId: "engineer", dir: out });
    expect(fs.readdirSync(out)).toEqual([]);
  });

  it("the plain export still answers to the positional dir and writes the seat block into agent.json", async () => {
    await installEngineerWithSkill();
    const out = outDir("plain");
    const result = await runCli(["fleet", "export", "engineer", out, "--json"]);
    expect(result.exitCode).toBe(EXIT.OK);
    const bundle = JSON.parse(fs.readFileSync(path.join(out, "agent.json"), "utf8")) as { seat?: { budgetCents: number } };
    expect(bundle.seat?.budgetCents).toBe(seatCapability("engineer").budgetCents);
    expect(fs.existsSync(path.join(out, ".mcp.json"))).toBe(false);
    const neither = await runCli(["fleet", "export", "engineer", "--json"]);
    expect(neither.exitCode).toBe(EXIT.USAGE);
  });
});
