/**
 * X6 — `fleet import --from codex`: a `.codex/agents/<name>.toml` (name, description,
 * developer_instructions, `[mcp_servers.*]`, the sandbox and approval keys) with the sibling
 * `AGENTS.md` and `.agents/skills/`. The exporter's own output reads back to an equivalent
 * record; a hand-written agent's permissions map onto toolsets; the TOML reader covers the
 * subset an agent file uses and refuses what it cannot read rather than guessing.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { InMemoryImproveStore } from "../improve/memory-store.js";
import type { AgentDefinition } from "../store/StorePort.js";
import { createAgentVersions, type AgentDefinitionSource } from "./AgentVersions.js";
import { exportCodexAgents } from "./export-codex.js";
import { codexToolsets, parseTomlSubset, readCodexAgent } from "./import-codex.js";
import { importForeignAgent } from "./import-foreign.js";

const dirs: string[] = [];
const tmp = (label: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `trent-${label}-`));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const PROMPT = "You are the finance seat. Cents are integers.";
const SKILL = "# Ledger Check\n> Reconcile the ledger.\n\nEvery line balances.";

function versions() {
  const source: AgentDefinitionSource = {
    async definition(): Promise<AgentDefinition> {
      return { prompt: PROMPT, model: { provider: "anthropic", model: "claude-sonnet-4-5" }, toolsets: ["file_ops"], skills: [{ slug: "ledger-check", content: SKILL }] };
    },
  };
  return createAgentVersions({ store: new InMemoryImproveStore(), companyId: "co", source });
}

const MODEL = { provider: "anthropic", model: "claude-sonnet-4-5" };

function writeCodexAgent(root: string, name: string, toml: string): string {
  const dir = path.join(root, ".codex", "agents");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.toml`);
  fs.writeFileSync(file, toml, "utf8");
  return file;
}

describe("parseTomlSubset", () => {
  it("reads basic and multi-line strings, arrays, booleans, integers, dotted and quoted table headers", () => {
    const parsed = parseTomlSubset(['name = "a"', 'text = """', 'line "one"', "line two", '"""', "flag = true", "count = 3", 'list = ["x", "y"]', "", "[mcp_servers.gh]", 'command = "gh"', "args = []", "", '[plugins."docs@openai"]', "enabled = false", "", "[a.b]", 'c = "d"'].join("\n"));
    // The newline before the closing quotes is part of the string, as TOML says.
    expect(parsed).toEqual({ name: "a", text: 'line "one"\nline two\n', flag: true, count: 3, list: ["x", "y"], mcp_servers: { gh: { command: "gh", args: [] } }, plugins: { "docs@openai": { enabled: false } }, a: { b: { c: "d" } } });
  });

  it("refuses a line it cannot read, naming the line number and never guessing", () => {
    expect(() => parseTomlSubset('name = "a"\nweird = { inline = 1 }')).toThrow(/line 2/);
  });
});

describe("readCodexAgent on the exporter's own output", () => {
  it("reads the seat prompt, the skill and Trent's own server back; the toolsets are not in the file", async () => {
    const out = tmp("codex-export");
    await exportCodexAgents({ versions: versions(), target: "finance", dir: out, profileDir: tmp("profile"), profile: "default" });
    const agent = readCodexAgent(out);
    expect(agent.format).toBe("codex");
    expect(agent.agentId).toBe("finance");
    expect(agent.prompt.trim()).toBe(PROMPT);
    expect(agent.skills.map((s) => s.slug)).toEqual(["ledger-check"]);
    expect(agent.skills[0]?.content).toContain("Every line balances.");
    expect(agent.mcpServers).toEqual([]);
    expect(agent.notCarried.some((line) => /trent mcp serve/.test(line))).toBe(true);
    expect(agent.notCarried.some((line) => /toolsets/.test(line))).toBe(true);
    expect(agent.sources).toContain(path.join(".codex", "agents", "finance.toml"));
    expect(agent.sources).toContain("AGENTS.md");
  });

  it("imports back to a candidate with the same prompt and skill", async () => {
    const out = tmp("codex-round-trip");
    await exportCodexAgents({ versions: versions(), target: "finance", dir: out, profileDir: tmp("profile") });
    const result = await importForeignAgent({ versions: versions(), target: out, format: "codex", profile: { agentsDir: tmp("c-agents"), skillsDir: tmp("c-skills") }, model: MODEL, mcpServers: { has: () => false, set: () => undefined } });
    expect(result.version.label).toBe("candidate");
    expect(result.version.definition.prompt.trim()).toBe(PROMPT);
    expect(result.version.definition.skills.map((s) => s.slug)).toEqual(["ledger-check"]);
  });
});

describe("a foreign Codex agent", () => {
  it("maps the sandbox, network, web search, mcp and permissions keys onto toolsets", () => {
    expect(codexToolsets({ sandbox_mode: "read-only" })).toEqual({ toolsets: ["file_ops"], denied: [], notes: [] });
    expect(codexToolsets({ sandbox_mode: "workspace-write", sandbox_workspace_write: { network_access: true } })).toEqual({ toolsets: ["file_ops", "terminal", "web"], denied: [], notes: [] });
    expect(codexToolsets({ sandbox_mode: "danger-full-access", web_search: "disabled", mcp_servers: { gh: {} } })).toEqual({ toolsets: ["file_ops", "terminal", "code", "mcp"], denied: ["web"], notes: [] });
    const permissions = codexToolsets({ permissions: { allow: ["Read", "Bash(git *)", "WebFetch"], deny: ["Edit", "Rocket"] } });
    // Read is allowed and Edit denied: a toolset is granted whole, so the stricter reading wins and is noted.
    expect(permissions.toolsets).toEqual(["terminal", "web"]);
    expect(permissions.denied).toEqual(["file_ops"]);
    expect(permissions.notes.join(" ")).toContain("Rocket");
    expect(permissions.notes.join(" ")).toContain("toolset file_ops");
  });

  it("reads name, description, developer_instructions and the sibling AGENTS.md, with the model named as not carried", () => {
    const root = tmp("codex-foreign");
    writeCodexAgent(root, "auditor", ['name = "auditor"', 'description = "Audits the books"', 'model = "gpt-5-codex"', 'sandbox_mode = "read-only"', 'developer_instructions = """', "Check every invoice.", '"""', "", "[mcp_servers.books]", 'command = "books-mcp"', 'args = ["--stdio"]', ""].join("\n"));
    fs.writeFileSync(path.join(root, "AGENTS.md"), "# House rules\n\nNever round.\n");
    fs.mkdirSync(path.join(root, ".agents", "skills", "invoice-read"), { recursive: true });
    fs.writeFileSync(path.join(root, ".agents", "skills", "invoice-read", "SKILL.md"), "---\nname: invoice-read\ndescription: Read an invoice.\n---\n# Invoice read\n\nTotals last.\n");
    const agent = readCodexAgent(path.join(root, ".codex", "agents", "auditor.toml"));
    expect(agent.agentId).toBe("auditor");
    expect(agent.description).toBe("Audits the books");
    expect(agent.prompt).toContain("Check every invoice.");
    expect(agent.prompt).toContain("Never round.");
    expect(agent.toolsets).toEqual(["file_ops", "mcp"]);
    expect(agent.skills.map((s) => s.slug)).toEqual(["invoice-read"]);
    expect(agent.mcpServers).toMatchObject([{ name: "books", entry: { transport: "stdio", command: "books-mcp", args: ["--stdio"], env: {} } }]);
    expect(agent.notCarried.find((line) => line.startsWith("model"))).toContain("gpt-5-codex");
  });

  it("refuses a file without the three required keys, typed", () => {
    const root = tmp("codex-missing");
    const file = writeCodexAgent(root, "half", 'name = "half"\n');
    expect(() => readCodexAgent(file)).toThrow(/developer_instructions/);
  });
});
