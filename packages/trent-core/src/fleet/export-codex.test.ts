/**
 * W5 — `fleet export --target codex`: a seat (or a pack) as the files a Codex CLI user drops into
 * a project. `renderCodexAgent` is a pure function over the bundle whose output parses as TOML
 * with the three fields Codex requires (`name`, `description`, `developer_instructions`) and a
 * `[mcp_servers.trent]` table; `AGENTS.md` carries the approval rules and the skills index; the
 * skills land where Codex looks (`.agents/skills/`). The format is one OpenAI says may evolve,
 * so the test pins what the docs name today and nothing more.
 */
import TOML from "@iarna/toml";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { InMemoryImproveStore } from "../improve/memory-store.js";
import { parseFrontmatter } from "../skills/skill-store.js";
import type { AgentDefinition } from "../store/StorePort.js";
import { createAgentVersions, type AgentDefinitionSource } from "./AgentVersions.js";
import { exportAgent, importAgent, type AgentBundle } from "./export.js";
import { CODEX_MCP_SERVER_NAME, exportCodexAgents, renderCodexAgent, renderCodexAgentsMd, tomlString } from "./export-codex.js";
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

function source(prompt?: string): AgentDefinitionSource {
  return {
    async definition(agentId): Promise<AgentDefinition> {
      return {
        prompt: prompt ?? `You are the ${agentId} seat. Ship small commits.`,
        model: { provider: "anthropic", model: "claude-sonnet-4-5" },
        toolsets: agentId === "finance" ? ["file_ops"] : ["file_ops", "terminal"],
        skills: [{ slug: "repo-audit", content: "# Repository Audit\n> Map the codebase.\n\nList every package." }],
      };
    },
  };
}

function versions(prompt?: string) {
  return createAgentVersions({ store: new InMemoryImproveStore(), companyId: "co", source: source(prompt) });
}

async function bundleFor(agentId: string, prompt?: string): Promise<AgentBundle> {
  return (await exportAgent({ versions: versions(prompt), agentId, dir: tmp("bundle") })).bundle;
}

interface CodexAgentToml {
  name: string;
  description: string;
  developer_instructions: string;
  model?: unknown;
  mcp_servers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
}

describe("renderCodexAgent is a pure function over the bundle", () => {
  it("emits TOML that parses with the three required fields and the trent server table, and no model", async () => {
    const bundle = await bundleFor("engineer");
    const options = { descriptions: new Map([["repo-audit", "Map the codebase."]]), profile: "default" };
    const text = renderCodexAgent(bundle, options);
    expect(renderCodexAgent(bundle, options)).toBe(text);
    const parsed = TOML.parse(text) as unknown as CodexAgentToml;
    expect(parsed.name).toBe("engineer");
    expect(parsed.description.length).toBeGreaterThan(10);
    expect(parsed.developer_instructions).toContain("Ship small commits.");
    expect(parsed.developer_instructions).toContain("trent approvals approve");
    for (const gate of seatCapability("engineer").approvalGates) expect(parsed.developer_instructions).toContain(gate);
    expect(parsed.model).toBeUndefined();
    const server = parsed.mcp_servers[CODEX_MCP_SERVER_NAME]!;
    expect(server.command).toBe("trent");
    expect(server.args).toEqual(["mcp", "serve", "--stdio", "--profile", "default"]);
    expect(server.env).toEqual({ TRENT_QUEUE_FALLBACK: "disabled" });
  });

  it("survives a prompt with quotes, backslashes and triple quotes", async () => {
    const prompt = 'Say "hello" with a \\ backslash, a """ triple quote and a tab\there.\nSecond line ends with \\';
    const bundle = await bundleFor("engineer", prompt);
    const parsed = TOML.parse(renderCodexAgent(bundle, { descriptions: new Map() })) as unknown as CodexAgentToml;
    expect(parsed.developer_instructions).toContain(prompt);
    expect(TOML.parse(`v = ${tomlString('a "quoted" \\ value')}`)).toEqual({ v: 'a "quoted" \\ value' });
  });

  it("writes AGENTS.md with the approval rules, the skills index and the server snippet", async () => {
    const bundle = await bundleFor("engineer");
    const text = renderCodexAgentsMd([bundle], { descriptions: new Map([["repo-audit", "Map the codebase."]]), profile: "default" });
    expect(text).toContain("trent approvals approve");
    expect(text).toContain("repo-audit");
    expect(text).toContain(".agents/skills/repo-audit/SKILL.md");
    expect(text).toContain(`[mcp_servers.${CODEX_MCP_SERVER_NAME}]`);
    expect(text).toContain(".codex/agents/engineer.toml");
  });
});

describe("exportCodexAgents for one seat", () => {
  it("writes the agent file, AGENTS.md, the skills under .agents/skills and the plain bundle", async () => {
    const out = tmp("codex-seat");
    const result = await exportCodexAgents({ versions: versions(), target: "engineer", dir: out, profileDir: tmp("profile"), profile: "default" });
    expect(result.agents).toEqual(["engineer"]);
    expect(result.persona).toBe(false);
    for (const relative of [path.join(".codex", "agents", "engineer.toml"), "AGENTS.md", path.join(".agents", "skills", "repo-audit", "SKILL.md"), "agent.json", path.join("skills", "repo-audit", "SKILL.md")]) {
      expect(result.files.map((f) => path.relative(out, f)), relative).toContain(relative);
      expect(fs.existsSync(path.join(out, relative)), relative).toBe(true);
    }
    const parsed = TOML.parse(fs.readFileSync(path.join(out, ".codex", "agents", "engineer.toml"), "utf8")) as unknown as CodexAgentToml;
    expect(parsed.name).toBe("engineer");
    const skill = parseFrontmatter(fs.readFileSync(path.join(out, ".agents", "skills", "repo-audit", "SKILL.md"), "utf8"));
    expect(skill.fields.name).toBe("repo-audit");
    expect(skill.fields.description).toBe("Map the codebase.");
  });

  it("round-trips: fleet import of the export restores the record with its seat block", async () => {
    const out = tmp("codex-round-trip");
    await exportCodexAgents({ versions: versions(), target: "engineer", dir: out, profileDir: tmp("profile") });
    const fresh = tmp("fresh");
    const imported = await importAgent({ versions: versions(), dir: out, profile: { agentsDir: path.join(fresh, "agents"), skillsDir: path.join(fresh, "skills") } });
    expect(imported.version.agentId).toBe("engineer");
    const record = JSON.parse(fs.readFileSync(path.join(fresh, "agents", "engineer.json"), "utf8")) as { seat?: { budgetCents: number } };
    expect(record.seat?.budgetCents).toBe(seatCapability("engineer").budgetCents);
  });

  it("refuses a target that is neither a pack nor an agent", async () => {
    await expect(exportCodexAgents({ versions: versions(), target: "no-such-thing", dir: tmp("x"), profileDir: tmp("p") })).rejects.toThrow(/no-such-thing/);
  });
});

describe("exportCodexAgents for a pack", () => {
  it("writes one agent file per seat member with the persona, one AGENTS.md naming them all, the skills once", async () => {
    const profileDir = tmp("profile-pack");
    fs.mkdirSync(path.join(profileDir, "brain", "system"), { recursive: true });
    fs.writeFileSync(path.join(profileDir, "brain", "system", "persona-executive.md"), "The executive crew keeps the founder's week honest.\n");
    const out = tmp("codex-pack");
    const result = await exportCodexAgents({ versions: versions(), target: "executive", dir: out, profileDir });
    expect(result.pack).toBe("executive");
    expect(result.persona).toBe(true);
    expect(result.agents).toEqual(["ceo", "engineer", "growth", "finance"]);
    const agentsMd = fs.readFileSync(path.join(out, "AGENTS.md"), "utf8");
    for (const id of result.agents) {
      const parsed = TOML.parse(fs.readFileSync(path.join(out, ".codex", "agents", `${id}.toml`), "utf8")) as unknown as CodexAgentToml;
      expect(parsed.name).toBe(id);
      expect(parsed.developer_instructions).toContain("The executive crew keeps the founder's week honest.");
      expect(parsed.developer_instructions).toContain(`You are the ${id} seat.`);
      expect(agentsMd).toContain(`.codex/agents/${id}.toml`);
    }
    expect(fs.existsSync(path.join(out, ".agents", "skills", "repo-audit", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(out, "agents", "ceo", "agent.json"))).toBe(true);
  });
});
