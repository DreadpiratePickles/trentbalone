/**
 * W5 — `trent fleet export <id|pack> --target hermes|codex --out DIR` through `runCli`, with the
 * injected in-memory improve store and a temporary TRENT_HOME, like the Claude suite: the Hermes
 * profile distribution (manifest, SOUL.md, config.yaml, mcp.json, skills, archive) and the Codex
 * agent file plus AGENTS.md, both beside the plain bundle `fleet import` reads back.
 */
import TOML from "@iarna/toml";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EXIT } from "@trent/core/errors/index.js";
import { seatCapability } from "@trent/core/fleet/index.js";
import { InMemoryImproveStore } from "@trent/core/improve/index.js";
import { runCli } from "../index.js";
import { setImproveStoreForTests } from "../improve.js";

let home: string;
const extra: string[] = [];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-fleet-hc-"));
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `trent-hc-${label}-`));
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

describe("trent fleet export --target hermes", () => {
  it("writes the distribution for this profile, the archive, and reports the profile", async () => {
    await installEngineerWithSkill();
    const out = outDir("hermes");
    const result = await runCli(["fleet", "export", "engineer", "--target", "hermes", "--out", out, "--json"]);
    expect(result.exitCode).toBe(EXIT.OK);
    const data = JSON.parse(result.stdout) as { target: string; agents: string[]; files: string[]; persona: boolean; dir: string; profiles: Array<{ agentId: string; name: string; archive: string }> };
    expect(data.target).toBe("hermes");
    expect(data.agents).toEqual(["engineer"]);
    expect(data.profiles).toEqual([{ agentId: "engineer", name: "trent-engineer", archive: "trent-engineer.tar.gz" }]);
    for (const relative of ["distribution.yaml", "SOUL.md", "config.yaml", "mcp.json", "skills/repo-audit/SKILL.md", "agent.json", "trent-engineer.tar.gz"]) {
      expect(data.files, relative).toContain(relative);
      expect(fs.existsSync(path.join(out, relative)), relative).toBe(true);
    }
    const config = parseYaml(fs.readFileSync(path.join(out, "config.yaml"), "utf8")) as { mcp_servers: { trent: { args: string[] } }; platform_toolsets: { cli: string[] } };
    expect(config.mcp_servers.trent.args).toEqual(["mcp", "serve", "--stdio", "--profile", "default"]);
    expect(config.platform_toolsets.cli).toContain("terminal");
    expect(fs.readFileSync(path.join(out, "SOUL.md"), "utf8")).toContain("trent approvals approve");
  });

  it("round-trips: fleet import of the Hermes export restores the record with its seat block", async () => {
    await installEngineerWithSkill();
    const out = outDir("hermes-round-trip");
    expect((await runCli(["fleet", "export", "engineer", "--target", "hermes", "--out", out, "--json"])).exitCode).toBe(EXIT.OK);

    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-fresh-hermes-"));
    extra.push(fresh);
    process.env.TRENT_HOME = fresh;
    setImproveStoreForTests(new InMemoryImproveStore());
    const imported = await runCli(["fleet", "import", out, "--json"]);
    expect(imported.exitCode).toBe(EXIT.OK);
    const record = JSON.parse(fs.readFileSync(path.join(fresh, "agents", "engineer.json"), "utf8")) as { seat?: { budgetCents: number; toolsets: string[] }; installed_skills: string[] };
    const seat = seatCapability("engineer");
    expect(record.seat).toMatchObject({ budgetCents: seat.budgetCents, toolsets: [...seat.toolsets] });
    expect(record.installed_skills).toEqual(["repo-audit"]);
  });

  it("exports a pack as one profile per seat member with the persona", async () => {
    fs.mkdirSync(path.join(home, "brain", "system"), { recursive: true });
    fs.writeFileSync(path.join(home, "brain", "system", "persona-executive.md"), "The executive crew keeps the founder's week honest.\n");
    const out = outDir("hermes-pack");
    const result = await runCli(["fleet", "export", "executive", "--target", "hermes", "--out", out, "--json"]);
    expect(result.exitCode).toBe(EXIT.OK);
    const data = JSON.parse(result.stdout) as { agents: string[]; persona: boolean; pack?: string; profiles: Array<{ agentId: string; name: string }> };
    expect(data.pack).toBe("executive");
    expect(data.persona).toBe(true);
    expect(data.profiles.map((p) => p.name)).toEqual(["trent-ceo", "trent-engineer", "trent-growth", "trent-finance"]);
    expect(fs.readFileSync(path.join(out, "finance", "SOUL.md"), "utf8")).toContain("keeps the founder's week honest");
    expect(fs.existsSync(path.join(out, "finance", "trent-finance.tar.gz"))).toBe(true);
  });
});

describe("trent fleet export --target codex", () => {
  it("writes the agent file, AGENTS.md and the skills, and reports them", async () => {
    await installEngineerWithSkill();
    const out = outDir("codex");
    const result = await runCli(["fleet", "export", "engineer", "--target", "codex", "--out", out, "--json"]);
    expect(result.exitCode).toBe(EXIT.OK);
    const data = JSON.parse(result.stdout) as { target: string; agents: string[]; files: string[] };
    expect(data.target).toBe("codex");
    expect(data.agents).toEqual(["engineer"]);
    for (const relative of [".codex/agents/engineer.toml", "AGENTS.md", ".agents/skills/repo-audit/SKILL.md", "agent.json"]) {
      expect(data.files, relative).toContain(relative);
      expect(fs.existsSync(path.join(out, relative)), relative).toBe(true);
    }
    const agent = TOML.parse(fs.readFileSync(path.join(out, ".codex", "agents", "engineer.toml"), "utf8")) as unknown as { name: string; developer_instructions: string; mcp_servers: { trent: { args: string[] } } };
    expect(agent.name).toBe("engineer");
    expect(agent.developer_instructions).toContain("trent approvals approve");
    expect(agent.mcp_servers.trent.args).toEqual(["mcp", "serve", "--stdio", "--profile", "default"]);
    expect(fs.readFileSync(path.join(out, "AGENTS.md"), "utf8")).toContain("[mcp_servers.trent]");
  });

  it("round-trips: fleet import of the Codex export restores the record with its seat block", async () => {
    await installEngineerWithSkill();
    const out = outDir("codex-round-trip");
    expect((await runCli(["fleet", "export", "engineer", "--target", "codex", "--out", out, "--json"])).exitCode).toBe(EXIT.OK);

    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-fresh-codex-"));
    extra.push(fresh);
    process.env.TRENT_HOME = fresh;
    setImproveStoreForTests(new InMemoryImproveStore());
    const imported = await runCli(["fleet", "import", out, "--json"]);
    expect(imported.exitCode).toBe(EXIT.OK);
    const record = JSON.parse(fs.readFileSync(path.join(fresh, "agents", "engineer.json"), "utf8")) as { seat?: { budgetCents: number } };
    expect(record.seat?.budgetCents).toBe(seatCapability("engineer").budgetCents);
  });

  it("still refuses a target it does not render, and --dry-run names the target without writing", async () => {
    const out = outDir("refused");
    const grok = await runCli(["fleet", "export", "engineer", "--target", "grok", "--out", out, "--json"]);
    expect(grok.exitCode).toBe(EXIT.USAGE);
    expect(`${grok.stdout}${grok.stderr}`).toContain("hermes");
    expect(`${grok.stdout}${grok.stderr}`).toContain("codex");
    const dry = await runCli(["fleet", "export", "engineer", "--target", "hermes", "--out", out, "--json", "--dry-run"]);
    expect(dry.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(dry.stdout)).toMatchObject({ dryRun: true, command: "fleet export", target: "hermes", agentId: "engineer", dir: out });
    expect(fs.readdirSync(out)).toEqual([]);
  });
});
