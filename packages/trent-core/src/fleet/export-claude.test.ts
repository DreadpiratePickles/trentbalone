/**
 * U5 — `fleet export --target claude`: a seat (or a pack) as files a Claude Code or Grok Build
 * user drops into a project. `.claude/agents/<name>.md` carries the seat prompt, the pack persona,
 * what Trent asks before doing and the skills index; its `tools:` line names only MCP tools the
 * `trent` server exposes; `.mcp.json` points the host at `trent mcp serve --stdio`; the skills are
 * copied in the Agent Skills layout with Trent's fields under `metadata.trent`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { InMemoryImproveStore } from "../improve/memory-store.js";
import { mcpToolNamesFor } from "../mcp-server/toolset-tools.js";
import { parseFrontmatter, writeSkillRecord } from "../skills/skill-store.js";
import type { AgentDefinition } from "../store/StorePort.js";
import { createAgentVersions, type AgentDefinitionSource } from "./AgentVersions.js";
import { CLAUDE_MCP_SERVER_NAME, claudeToolName, exportClaudeAgents } from "./export-claude.js";
import { seatCapability } from "./seat-capabilities.js";

const dirs: string[] = [];
const tmp = (label: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `trent-${label}-`));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function source(): AgentDefinitionSource {
  return {
    async definition(agentId): Promise<AgentDefinition> {
      return {
        prompt: `You are the ${agentId} seat. Ship small commits.`,
        model: { provider: "anthropic", model: "claude-sonnet-4-5" },
        toolsets: agentId === "finance" ? ["file_ops"] : ["file_ops", "terminal"],
        skills: [{ slug: "repo-audit", content: "# Repository Audit\n> Map the codebase.\n\nList every package." }],
      };
    },
  };
}

function versions() {
  return createAgentVersions({ store: new InMemoryImproveStore(), companyId: "co", source: source() });
}

describe("exportClaudeAgents for one seat", () => {
  it("writes a parseable subagent file whose tools are only what the trent server exposes, plus .mcp.json and the bundle", async () => {
    const out = tmp("claude-seat");
    const profileDir = tmp("profile");
    const result = await exportClaudeAgents({ versions: versions(), target: "engineer", dir: out, profileDir, profile: "default" });
    expect(result.agents).toEqual(["engineer"]);
    expect(result.persona).toBe(false);

    const file = path.join(out, ".claude", "agents", "engineer.md");
    expect(result.files.map((f) => path.relative(out, f))).toContain(path.join(".claude", "agents", "engineer.md"));
    const { fields, body } = parseFrontmatter(fs.readFileSync(file, "utf8"));
    expect(fields.name).toBe("engineer");
    expect(fields.description!.length).toBeGreaterThan(10);
    expect(fields.model).toBeUndefined();
    const tools = fields.tools!.split(",").map((t) => t.trim());
    expect(tools.length).toBeGreaterThan(3);
    const exposed = new Set(mcpToolNamesFor(seatCapability("engineer").toolsets).map(claudeToolName));
    for (const tool of tools) {
      expect(tool.startsWith(`mcp__${CLAUDE_MCP_SERVER_NAME}__`), tool).toBe(true);
      expect(exposed.has(tool), `${tool} is not a tool the server exposes`).toBe(true);
    }
    expect(body).toContain("Ship small commits.");
    expect(body).toContain("trent approvals approve");
    for (const gate of seatCapability("engineer").approvalGates) expect(body).toContain(gate);
    expect(body).toContain("repo-audit");
    expect(body).toContain("skills/repo-audit/SKILL.md");

    const mcp = JSON.parse(fs.readFileSync(path.join(out, ".mcp.json"), "utf8")) as { mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> };
    const server = mcp.mcpServers[CLAUDE_MCP_SERVER_NAME]!;
    expect(server.command).toBe("trent");
    expect(server.args).toEqual(["mcp", "serve", "--stdio", "--profile", "default"]);
    expect(server.env).toEqual({ TRENT_QUEUE_FALLBACK: "disabled" });

    // The plain bundle is there too, so `fleet import <dir>` reads it back.
    expect(fs.existsSync(path.join(out, "agent.json"))).toBe(true);
    const skill = parseFrontmatter(fs.readFileSync(path.join(out, "skills", "repo-audit", "SKILL.md"), "utf8"));
    expect(skill.fields.name).toBe("repo-audit");
    expect(skill.fields.description).toBe("Map the codebase.");
    expect(skill.body).toContain("List every package.");
  });

  it("copies a canonical skill with its bundle directories, Trent's own fields nested under metadata.trent", async () => {
    const skillsDir = tmp("skills");
    const written = writeSkillRecord(skillsDir, { name: "repo-audit", description: "Map the codebase.", instructions: "List every package.", trust: "trusted", createdBy: "agent" });
    fs.mkdirSync(path.join(path.dirname(written), "tools"), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(written), "tools", "count.py"), "print(1)\n");
    fs.mkdirSync(path.join(path.dirname(written), "scripts"), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(written), "scripts", "run.sh"), "ls\n");
    const out = tmp("claude-skills");
    await exportClaudeAgents({ versions: versions(), target: "engineer", dir: out, profileDir: tmp("profile"), skillsDir });
    const text = fs.readFileSync(path.join(out, "skills", "repo-audit", "SKILL.md"), "utf8");
    expect(text).toContain("metadata:\n  trent:\n");
    expect(text).not.toMatch(/^trust:/m);
    const { fields } = parseFrontmatter(text);
    expect(fields.trust).toBe("trusted");
    expect(fields.created_by).toBe("agent");
    expect(fs.existsSync(path.join(out, "skills", "repo-audit", "tools", "count.py"))).toBe(true);
    expect(fs.existsSync(path.join(out, "skills", "repo-audit", "scripts", "run.sh"))).toBe(true);
  });

  it("refuses a target that is neither a pack nor an agent", async () => {
    await expect(exportClaudeAgents({ versions: versions(), target: "no-such-thing", dir: tmp("x"), profileDir: tmp("p") })).rejects.toThrow(/no-such-thing/);
  });
});

describe("exportClaudeAgents for a pack", () => {
  it("writes one subagent per member with the pack's persona from brain/system, one .mcp.json, and the skills once", async () => {
    const profileDir = tmp("profile-pack");
    fs.mkdirSync(path.join(profileDir, "brain", "system"), { recursive: true });
    fs.writeFileSync(path.join(profileDir, "brain", "system", "persona-executive.md"), "The executive crew keeps the founder's week honest.\n");
    const out = tmp("claude-pack");
    const result = await exportClaudeAgents({ versions: versions(), target: "executive", dir: out, profileDir });
    expect(result.pack).toBe("executive");
    expect(result.persona).toBe(true);
    expect(result.agents).toEqual(["ceo", "engineer", "growth", "finance"]);
    for (const id of result.agents) {
      const { fields, body } = parseFrontmatter(fs.readFileSync(path.join(out, ".claude", "agents", `${id}.md`), "utf8"));
      expect(fields.name).toBe(id);
      expect(body).toContain("The executive crew keeps the founder's week honest.");
      expect(body).toContain(`You are the ${id} seat.`);
    }
    // finance's manifest has no terminal: its tools line must not name it.
    const finance = parseFrontmatter(fs.readFileSync(path.join(out, ".claude", "agents", "finance.md"), "utf8")).fields.tools!;
    expect(finance).not.toContain(claudeToolName("terminal"));
    expect(fs.existsSync(path.join(out, ".mcp.json"))).toBe(true);
    expect(fs.existsSync(path.join(out, "skills", "repo-audit", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(out, "agents", "ceo", "agent.json"))).toBe(true);
  });

  it("a pack with no persona file exports without one and says so", async () => {
    const out = tmp("claude-pack-none");
    const result = await exportClaudeAgents({ versions: versions(), target: "eng-trio", dir: out, profileDir: tmp("profile-none") });
    expect(result.persona).toBe(false);
    // Members that are neither seats nor installed agents are skipped by name, not invented.
    expect(result.agents).toEqual(["engineer"]);
    expect(result.skipped.map((s) => s.agentId).sort()).toEqual(["eng-ai-engineer", "eng-backend-architect"]);
  });
});
