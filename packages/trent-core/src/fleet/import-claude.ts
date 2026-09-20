/**
 * X6 — `fleet import --from claude`: a Claude Code subagent (research 1a,
 * https://code.claude.com/docs/en/sub-agents) read into the foreign-agent shape:
 *
 *   <root>/.claude/agents/<name>.md   frontmatter `name`, `description`, `tools`,
 *                                     `disallowedTools`, `skills`, `model`, and the rest; the
 *                                     body is the prompt (the `## Seat prompt` section when the
 *                                     file is one `fleet export --target claude` wrote)
 *   <root>/skills/<slug>/SKILL.md     the project's skills (also `.claude/skills/`): the ones
 *   <root>/.claude/skills/<slug>/     `skills:` names, else all of them
 *   <root>/.mcp.json                  `mcpServers`, each normalised to the profile's shape
 *
 * Claude Code's built-in tool names are the host's, so they are mapped onto Trent toolsets by
 * what they do (`CLAUDE_TOOL_TOOLSETS`); `mcp__trent__<tool>` names go back to the toolset that
 * exposes the tool; any other `mcp__` name is the `mcp` toolset; a name in neither table is
 * reported, not guessed. `model`, `effort`, `permissionMode`, `maxTurns`, `memory`, `hooks` and
 * the other host-only fields are reported as not carried.
 */
import fs from "node:fs";
import path from "node:path";

import { MCP_TOOLS_BY_TOOLSET } from "../mcp-server/toolset-tools.js";
import { parseFrontmatter } from "../skills/skill-store.js";
import { CLAUDE_MCP_SERVER_NAME } from "./export-claude.js";
import { agentIdFrom, knownToolsets, normaliseMcpEntry, readSkillTree, refuseImport, resolveGrants, seatPromptOf, type ForeignAgent, type ForeignMcpServer, type ForeignSkill } from "./import-foreign.js";

const AGENTS_DIR = path.join(".claude", "agents");
const MCP_JSON = ".mcp.json";
/** Where a project keeps skills: the Agent Skills layout at the root, and Claude's own directory. */
const SKILL_ROOTS: readonly string[] = ["skills", path.join(".claude", "skills")];
/** The frontmatter fields the record carries; every other field is named as not carried. */
const CARRIED_FIELDS: ReadonlySet<string> = new Set(["name", "description", "tools", "disallowedTools", "skills"]);
/** Tools every seat has whatever its toolsets (the todo list); nothing to map. */
const ALWAYS_ON_TOOLS: ReadonlySet<string> = new Set(["TodoWrite"]);

/** Claude Code built-in tool -> the Trent toolset that does the same job. */
export const CLAUDE_TOOL_TOOLSETS: Readonly<Record<string, string>> = {
  Read: "file_ops",
  Write: "file_ops",
  Edit: "file_ops",
  MultiEdit: "file_ops",
  Glob: "file_ops",
  Grep: "file_ops",
  LS: "file_ops",
  NotebookRead: "file_ops",
  NotebookEdit: "file_ops",
  Bash: "terminal",
  BashOutput: "terminal",
  KillShell: "terminal",
  WebFetch: "web",
  WebSearch: "web",
  Agent: "delegation",
  Task: "delegation",
  Skill: "skills",
  AskUserQuestion: "human",
};

function trentToolset(tool: string): string | undefined {
  for (const [toolset, names] of Object.entries(MCP_TOOLS_BY_TOOLSET)) if (names.includes(tool)) return toolset;
  return undefined;
}

/** A `tools:` list (comma-separated, or a block list the parser joined) as toolsets plus the names it could not place. */
export function claudeToolsets(tools: readonly string[]): { toolsets: string[]; unmapped: string[] } {
  const toolsets: string[] = [];
  const unmapped: string[] = [];
  for (const raw of tools) {
    // `Bash(git *)`: a permission pattern names the tool before the parenthesis.
    const name = raw.trim().replace(/\(.*\)$/, "");
    if (name === "" || ALWAYS_ON_TOOLS.has(name)) continue;
    let toolset: string | undefined = CLAUDE_TOOL_TOOLSETS[name];
    if (toolset === undefined && name.startsWith("mcp__")) {
      const [, server, ...rest] = name.split("__");
      toolset = server === CLAUDE_MCP_SERVER_NAME && rest.length > 0 ? trentToolset(rest.join("__")) : "mcp";
      // A Trent tool the server always exposes (todo, session search) maps to no toolset and is not an error.
      if (server === CLAUDE_MCP_SERVER_NAME && toolset === undefined) continue;
    }
    if (toolset === undefined) unmapped.push(name);
    else toolsets.push(toolset);
  }
  return { toolsets: knownToolsets(toolsets), unmapped };
}

function list(value: string | undefined): string[] {
  return (value ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

/** The agent file, from the file itself or a project directory holding exactly one. */
function agentFile(target: string): { file: string; root: string } {
  if (fs.statSync(target).isFile()) return { file: target, root: path.dirname(path.dirname(path.dirname(target))) };
  const dir = path.join(target, AGENTS_DIR);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort() : [];
  if (files.length === 0) throw refuseImport("claude", `no ${path.join(AGENTS_DIR, "<name>.md")} under ${target}`, target);
  if (files.length > 1) throw refuseImport("claude", `${dir} holds ${files.length} agents (${files.join(", ")}); give the one file to import`, target);
  return { file: path.join(dir, files[0]!), root: target };
}

function readMcpServers(root: string, sources: string[], notCarried: string[]): ForeignMcpServer[] {
  const file = path.join(root, MCP_JSON);
  if (!fs.existsSync(file)) return [];
  sources.push(MCP_JSON);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    notCarried.push(`${MCP_JSON}: not valid JSON (${error instanceof Error ? error.message : String(error)}); no server imported`);
    return [];
  }
  const servers = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as { mcpServers?: unknown }).mcpServers : undefined;
  if (servers === null || typeof servers !== "object" || Array.isArray(servers)) return [];
  const out: ForeignMcpServer[] = [];
  for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
    const { entry, notes } = normaliseMcpEntry(name, raw);
    notCarried.push(...notes);
    if (entry !== undefined) out.push({ name, entry });
  }
  return out;
}

export function readClaudeAgent(target: string): ForeignAgent {
  if (!fs.existsSync(target)) throw refuseImport("claude", `${target} does not exist`, target);
  const { file, root } = agentFile(target);
  const sources = [path.relative(root, file)];
  const notCarried: string[] = [];
  const { fields, body } = parseFrontmatter(fs.readFileSync(file, "utf8"));
  const name = fields.name ?? path.basename(file, ".md");
  const agentId = agentIdFrom("claude", name, target);
  if (fields.description === undefined) notCarried.push(`${sources[0]}: no description in the frontmatter; the record's description is empty`);

  const allowed = claudeToolsets(list(fields.tools));
  const denied = claudeToolsets(list(fields.disallowedTools));
  for (const tool of allowed.unmapped) notCarried.push(`tools: "${tool}" is not a Claude Code built-in Trent knows nor an MCP tool name; not mapped`);
  for (const tool of denied.unmapped) notCarried.push(`disallowedTools: "${tool}" is not a Claude Code built-in Trent knows nor an MCP tool name; not mapped`);
  if (fields.tools === undefined) notCarried.push("tools: none listed, so the host would inherit every tool; no toolset is granted until a person sets them");
  for (const [key, value] of Object.entries(fields)) {
    if (CARRIED_FIELDS.has(key)) continue;
    notCarried.push(`${key}: ${value} (Claude Code's own field; ${key === "model" ? "the model tier is left unset" : "no Trent equivalent"})`);
  }

  const wanted = new Set(list(fields.skills));
  const skills: ForeignSkill[] = [];
  const seen = new Set<string>();
  for (const skillRoot of SKILL_ROOTS) {
    for (const skill of readSkillTree(path.join(root, skillRoot), root, notCarried)) {
      if (seen.has(skill.slug) || (wanted.size > 0 && !wanted.has(skill.slug))) continue;
      seen.add(skill.slug);
      skills.push(skill);
      sources.push(skill.source);
    }
  }
  for (const slug of wanted) if (!seen.has(slug)) notCarried.push(`skills: "${slug}" is named but no ${SKILL_ROOTS.join(" or ")}/${slug}/SKILL.md sits beside the agent; not imported`);

  const mcpServers = readMcpServers(root, sources, notCarried);
  // A server the project configures is reached through the `mcp` toolset, whatever `tools:` says.
  const grants = resolveGrants([...allowed.toolsets, ...(mcpServers.length > 0 ? ["mcp"] : [])], denied.toolsets);
  notCarried.push(...grants.notes);
  const seat = seatPromptOf(body);
  if (seat.exported) notCarried.push(`${sources[0]}: the approval rules and skills index are Trent's own rendering and are regenerated on export, not stored in the prompt`);
  return {
    format: "claude",
    agentId,
    name,
    description: fields.description ?? "",
    prompt: seat.prompt,
    toolsets: grants.toolsets,
    denied: grants.denied,
    skills,
    mcpServers,
    notCarried,
    sources,
    cleanup: () => undefined,
  };
}
