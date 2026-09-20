/**
 * X6 — `fleet import --from codex`: a Codex CLI custom agent (research 1b,
 * https://learn.chatgpt.com/docs/agent-configuration/subagents.md) read into the foreign-agent
 * shape:
 *
 *   <root>/.codex/agents/<name>.toml   `name`, `description`, `developer_instructions` (required
 *                                      by Codex, so required here); `[mcp_servers.<id>]` tables;
 *                                      the sandbox, approval and web-search keys the file may set
 *                                      because it is a config layer for the spawned session
 *   <root>/AGENTS.md                   the project guidance the agent runs under, appended to the
 *                                      prompt as its own section (skipped when it is the one
 *                                      `fleet export --target codex` wrote: that text is regenerated)
 *   <root>/.agents/skills/<slug>/      the skills where Codex looks
 *
 * Codex has no tool allowlist: the tool surface is the sandbox plus the MCP servers, so the
 * toolsets come from `sandbox_mode`, `sandbox_workspace_write.network_access`, `web_search`,
 * `[mcp_servers]` and, when a file carries one, a `[permissions]` table in Claude Code's
 * vocabulary (what Codex's own `/import` writes from Claude settings). `model`,
 * `model_reasoning_effort`, `approval_policy` and every other key are reported as not carried.
 *
 * The TOML reader below covers the subset an agent file uses (basic strings, multi-line basic
 * strings, arrays of scalars, booleans, integers, floats, `[a.b]` and `[a."quoted"]` tables) and
 * refuses a line outside it, naming the line, rather than guessing at it.
 */
import fs from "node:fs";
import path from "node:path";

import { claudeToolsets } from "./import-claude.js";
import { agentIdFrom, knownToolsets, normaliseMcpEntry, readSkillTree, refuseImport, resolveGrants, seatPromptOf, type ForeignAgent, type ForeignMcpServer } from "./import-foreign.js";

const AGENTS_DIR = path.join(".codex", "agents");
const AGENTS_MD = "AGENTS.md";
const SKILLS_ROOT = path.join(".agents", "skills");
const REQUIRED_KEYS: readonly string[] = ["name", "description", "developer_instructions"];
/** The first line of the AGENTS.md the exporter writes; that text is Trent's own rendering. */
const EXPORTED_AGENTS_MD_HEADING = "# Trent agents in this project";
const CARRIED_KEYS: ReadonlySet<string> = new Set([...REQUIRED_KEYS, "sandbox_mode", "sandbox_workspace_write", "web_search", "mcp_servers", "permissions", "features"]);
/** What each `sandbox_mode` lets the agent do, as toolsets. */
const SANDBOX_TOOLSETS: Readonly<Record<string, readonly string[]>> = {
  "read-only": ["file_ops"],
  "workspace-write": ["file_ops", "terminal"],
  "danger-full-access": ["file_ops", "terminal", "code"],
};

type TomlValue = string | number | boolean | TomlValue[] | { [key: string]: TomlValue };
type TomlTable = { [key: string]: TomlValue };

function isTable(value: unknown): value is TomlTable {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function unescapeBasic(text: string): string {
  return text.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_, esc: string) => {
    switch (esc[0]) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "u":
      case "U":
        return String.fromCodePoint(Number.parseInt(esc.slice(1), 16));
      default:
        return esc;
    }
  });
}

/** One scalar or array value on one line; `undefined` when the text is not one this reader knows. */
function scalar(text: string): TomlValue | undefined {
  const t = text.trim();
  if (/^"(?:[^"\\]|\\.)*"$/.test(t)) return unescapeBasic(t.slice(1, -1));
  if (/^'[^']*'$/.test(t)) return t.slice(1, -1);
  if (t === "true" || t === "false") return t === "true";
  if (/^[+-]?\d+(?:_\d+)*$/.test(t)) return Number.parseInt(t.replace(/_/g, ""), 10);
  if (/^[+-]?\d+(?:_\d+)*\.\d+(?:[eE][+-]?\d+)?$/.test(t)) return Number.parseFloat(t.replace(/_/g, ""));
  if (t.startsWith("[") && t.endsWith("]")) {
    const inner = t.slice(1, -1).trim();
    if (inner === "") return [];
    const items: TomlValue[] = [];
    for (const part of inner.match(/"(?:[^"\\]|\\.)*"|'[^']*'|[^,\s][^,]*/g) ?? []) {
      const value = scalar(part);
      if (value === undefined || Array.isArray(value)) return undefined;
      items.push(value);
    }
    return items;
  }
  return undefined;
}

/** `a.b."c d"` as its segments. */
function keyPath(text: string): string[] | undefined {
  const parts = text.match(/"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+/g);
  if (!parts || parts.join(".") !== text.replace(/\s*\.\s*/g, ".")) return undefined;
  return parts.map((p) => (p.startsWith('"') ? unescapeBasic(p.slice(1, -1)) : p.startsWith("'") ? p.slice(1, -1) : p));
}

function tableAt(root: TomlTable, segments: readonly string[]): TomlTable {
  let current = root;
  for (const segment of segments) {
    const next = current[segment];
    if (next === undefined) current[segment] = {};
    else if (!isTable(next)) throw new Error(`"${segment}" is a value, not a table`);
    current = current[segment] as TomlTable;
  }
  return current;
}

/** The TOML subset an agent file uses; a line outside it is refused with its number. */
export function parseTomlSubset(text: string): TomlTable {
  const root: TomlTable = {};
  let current = root;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!;
    const line = raw.trim();
    const fail = (why: string): never => {
      throw new Error(`TOML line ${i + 1}: ${why}`);
    };
    if (line === "" || line.startsWith("#")) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      const segments = keyPath(header[1]!.trim()) ?? fail("unreadable table header");
      try {
        current = tableAt(root, segments);
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
      continue;
    }
    if (line.startsWith("[[")) fail("arrays of tables are not read");
    const eq = line.indexOf("=");
    if (eq <= 0) fail("expected key = value");
    const segments = keyPath(line.slice(0, eq).trim()) ?? fail("unreadable key");
    const rest = line.slice(eq + 1).trim();
    let value: TomlValue | undefined;
    if (rest.startsWith('"""')) {
      // A multi-line basic string runs to the next line that is exactly the closing quotes.
      const after = rest.slice(3);
      const body: string[] = [];
      if (after !== "") {
        const end = after.indexOf('"""');
        if (end >= 0) value = unescapeBasic(after.slice(0, end));
        else body.push(after);
      }
      if (value === undefined) {
        let closed = false;
        while (i + 1 < lines.length) {
          i += 1;
          const next = lines[i]!;
          const end = next.indexOf('"""');
          if (end >= 0) {
            body.push(next.slice(0, end));
            closed = true;
            break;
          }
          body.push(next);
        }
        if (!closed) fail("multi-line string never closes");
        value = unescapeBasic(body.join("\n"));
      }
    } else {
      value = scalar(rest.replace(/\s+#.*$/, ""));
    }
    if (value === undefined) fail("unreadable value (inline tables, dates and multi-line arrays are not read)");
    const leaf = segments.pop()!;
    tableAt(current, segments)[leaf] = value!;
  }
  return root;
}

/** The toolsets a Codex agent's permissions amount to, what it denies, and what could not be placed. */
export function codexToolsets(table: TomlTable): { toolsets: string[]; denied: string[]; notes: string[] } {
  const toolsets: string[] = [];
  const denied: string[] = [];
  const notes: string[] = [];
  const sandbox = typeof table.sandbox_mode === "string" ? table.sandbox_mode : undefined;
  if (sandbox !== undefined) {
    const mapped = SANDBOX_TOOLSETS[sandbox];
    if (mapped === undefined) notes.push(`sandbox_mode: "${sandbox}" is not a mode Trent knows; no toolset granted for it`);
    else toolsets.push(...mapped);
  }
  const workspace = table.sandbox_workspace_write;
  if (isTable(workspace) && workspace.network_access === true) toolsets.push("web");
  const search = table.web_search;
  if (search === true || (typeof search === "string" && search !== "disabled")) toolsets.push("web");
  else if (search === false || search === "disabled") denied.push("web");
  const features = table.features;
  if (isTable(features) && features.web_search_request === true) toolsets.push("web");
  if (isTable(table.mcp_servers) && Object.keys(table.mcp_servers).length > 0) toolsets.push("mcp");
  const permissions = table.permissions;
  if (isTable(permissions)) {
    const names = (value: TomlValue | undefined): string[] => (Array.isArray(value) ? value.map(String) : []);
    const allow = claudeToolsets(names(permissions.allow));
    const deny = claudeToolsets(names(permissions.deny));
    toolsets.push(...allow.toolsets);
    denied.push(...deny.toolsets);
    for (const name of [...allow.unmapped, ...deny.unmapped]) notes.push(`permissions: "${name}" is not a tool name Trent can place; not mapped`);
  }
  const resolved = resolveGrants(toolsets, denied);
  return { toolsets: resolved.toolsets, denied: resolved.denied, notes: [...notes, ...resolved.notes] };
}

/** The agent file, from the file itself or a project directory holding exactly one. */
function agentFile(target: string): { file: string; root: string } {
  if (fs.statSync(target).isFile()) return { file: target, root: path.dirname(path.dirname(path.dirname(target))) };
  const dir = path.join(target, AGENTS_DIR);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".toml")).sort() : [];
  if (files.length === 0) throw refuseImport("codex", `no ${path.join(AGENTS_DIR, "<name>.toml")} under ${target}`, target);
  if (files.length > 1) throw refuseImport("codex", `${dir} holds ${files.length} agents (${files.join(", ")}); give the one file to import`, target);
  return { file: path.join(dir, files[0]!), root: target };
}

function readServers(table: TomlTable, notCarried: string[]): ForeignMcpServer[] {
  if (!isTable(table.mcp_servers)) return [];
  const out: ForeignMcpServer[] = [];
  for (const [name, raw] of Object.entries(table.mcp_servers)) {
    const { entry, notes } = normaliseMcpEntry(name, raw);
    notCarried.push(...notes);
    if (entry !== undefined) out.push({ name, entry });
  }
  return out;
}

export function readCodexAgent(target: string): ForeignAgent {
  if (!fs.existsSync(target)) throw refuseImport("codex", `${target} does not exist`, target);
  const { file, root } = agentFile(target);
  const relative = path.relative(root, file);
  const sources = [relative];
  const notCarried: string[] = [];
  let table: TomlTable;
  try {
    table = parseTomlSubset(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw refuseImport("codex", `${relative}: ${error instanceof Error ? error.message : String(error)}`, target);
  }
  const missing = REQUIRED_KEYS.filter((key) => typeof table[key] !== "string");
  if (missing.length > 0) throw refuseImport("codex", `${relative} lacks ${missing.join(", ")}; Codex requires name, description and developer_instructions as strings`, target);
  const name = table.name as string;
  const agentId = agentIdFrom("codex", name, target);

  const mapped = codexToolsets(table);
  notCarried.push(...mapped.notes);
  if (table.sandbox_mode === undefined && table.permissions === undefined) notCarried.push("toolsets: the file sets no sandbox_mode and no permissions, so the agent inherits the parent session's; no toolset is granted until a person sets them");
  for (const [key, value] of Object.entries(table)) {
    if (CARRIED_KEYS.has(key)) continue;
    const shown = typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : Array.isArray(value) ? value.map(String).join(", ") : `[${Object.keys(value).join(", ")}]`;
    notCarried.push(`${key}: ${shown} (Codex's own key; ${key === "model" ? "the model tier is left unset" : "no Trent equivalent"})`);
  }

  const seat = seatPromptOf(table.developer_instructions as string);
  let prompt = seat.prompt;
  if (seat.exported) notCarried.push(`${relative}: the approval rules and skills index are Trent's own rendering and are regenerated on export, not stored in the prompt`);
  const guidance = path.join(root, AGENTS_MD);
  if (fs.existsSync(guidance) && fs.statSync(guidance).isFile()) {
    sources.push(AGENTS_MD);
    const text = fs.readFileSync(guidance, "utf8").trim();
    if (text.startsWith(EXPORTED_AGENTS_MD_HEADING)) notCarried.push(`${AGENTS_MD}: written by fleet export, regenerated on export; not appended to the prompt`);
    else if (text !== "") prompt = `${prompt}\n\n## Project guidance (${AGENTS_MD})\n\n${text}`;
  }

  const skills = readSkillTree(path.join(root, SKILLS_ROOT), root, notCarried);
  sources.push(...skills.map((s) => s.source));
  return {
    format: "codex",
    agentId,
    name,
    description: table.description as string,
    prompt,
    toolsets: mapped.toolsets,
    denied: mapped.denied,
    skills,
    mcpServers: readServers(table, notCarried),
    notCarried,
    sources,
    cleanup: () => undefined,
  };
}
