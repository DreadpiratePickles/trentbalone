/**
 * X6 — `fleet import <path> [--from claude|codex|hermes]`: an agent written for another harness
 * comes into a Trent profile the way any skill someone else wrote does, as untrusted content.
 *
 * The three readers (`import-claude.ts`, `import-codex.ts`, `import-hermes.ts`) are pure over the
 * disk: each turns its host's files into the one `ForeignAgent` shape below and names, in
 * `notCarried`, every field it saw and could not map. This file detects the format when none is
 * given, dispatches, and does the writing:
 *
 *   - the prompt goes through `SecurityScan`; a finding refuses the import outright, naming the
 *     file and the category (a version has no quarantine state to park it in);
 *   - every skill goes through the same scan, then lands in the profile's skill store as
 *     `trust: community`, `created_by: import`, and `status: quarantined` with the scanner's
 *     category when it was flagged, so a seat is never told about it until a person clears it;
 *   - every MCP server entry is normalised to the profile's `mcp_servers` shape, a literal secret
 *     is replaced by its `${NAME}` reference, and the install-time scan `trent mcp add` runs is
 *     run here too: a finding keeps the server out unless `allowFlagged`, in which case the
 *     entry is stored flagged, exactly as `--allow-flagged` stores it;
 *   - what passes becomes a NEW candidate version, never live (`fleet promote` is the human
 *     step), and the agent's record lands inactive with `imported_from` naming the format, the
 *     files read and the fields the host had no home for: budget, approval gates, model tier,
 *     eval suite, brain.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { MCP_SERVER_NAME_PATTERN, McpServerConfigSchema, type McpServerConfig } from "../config/sections/mcp-servers.js";
import { ToolsetSchema } from "../config/sections/tools.js";
import { EXIT, TrentError } from "../errors/index.js";
import { SecurityScan } from "../skills/SecurityScan.js";
import { findSkillRecord, parseFrontmatter, SKILL_NAME_PATTERN, writeSkillRecord, type SkillStatus } from "../skills/skill-store.js";
import { isSecretName } from "../terminal/env-scrub.js";
import { isBuiltinToolName } from "../tools/tool-names.js";
import { connectFailureReason, connectMcpServer } from "../tools/mcp/client.js";
import { containsTemplate } from "../tools/mcp/config.js";
import { scanMcpTools, type McpScanFinding } from "../tools/mcp/scan.js";
import type { AgentDefinition, AgentVersionRow } from "../store/StorePort.js";
import type { AgentVersions } from "./AgentVersions.js";
import type { ImportProfile } from "./export.js";

export type ForeignFormat = "claude" | "codex" | "hermes";
export const FOREIGN_FORMATS: readonly ForeignFormat[] = ["claude", "codex", "hermes"];
/** What `detectForeignFormat` answers: a host layout, or Trent's own bundle. */
export type DetectedFormat = ForeignFormat | "trent";

const SAFE_AGENT_ID = /^[a-z0-9][a-z0-9._-]*$/i;
const TRENT_SERVE_ARGS: readonly string[] = ["mcp", "serve"];
/** The exporters' own section headings; a body carrying them is one Trent wrote. */
const SEAT_PROMPT_HEADING = "## Seat prompt";
const SKILL_FILE = "SKILL.md";
/** The fields a seat record has that no host file carries; named on every import. */
const SEAT_FIELDS_NO_HOST_HAS: readonly string[] = [
  "budget (per-run cap in integer cents): the host has no per-agent budget; the profile's default cap is recorded on the agent",
  "approval gates: the host has no seat manifest; only the profile's floors and deny globs apply until a person sets them",
  "model tier: left unset; the profile's configured model is used until a person sets one",
  "eval suite: the host has no per-agent evals; none is attached",
  "brain: the host's memory never travels; the profile's brain stays as it is",
];

export interface ForeignSkill {
  readonly slug: string;
  /** The SKILL.md text as read: what is scanned and what the version carries. */
  readonly content: string;
  /** The skill's directory on disk when it has one, for its bundle directories. */
  readonly dir?: string;
  /** Host-relative path of the SKILL.md. */
  readonly source: string;
}

export interface ForeignMcpServer {
  readonly name: string;
  readonly entry: McpServerConfig;
}

/** The one shape every reader produces. */
export interface ForeignAgent {
  readonly format: ForeignFormat;
  /** The agent id Trent files it under; validated against the bundle's id pattern. */
  readonly agentId: string;
  /** The host's own display name, when it differs from the id. */
  readonly name: string;
  readonly description: string;
  readonly prompt: string;
  /** Trent toolset names the host's tools mapped onto, in the host's order, de-duplicated. */
  readonly toolsets: string[];
  readonly denied: string[];
  readonly skills: ForeignSkill[];
  readonly mcpServers: ForeignMcpServer[];
  /** Every field the reader saw and could not carry, one plain line each. */
  readonly notCarried: string[];
  /** Host-relative paths read. */
  readonly sources: string[];
  /** Releases anything the reader extracted (a tarball); a no-op for a directory. */
  cleanup(): void;
}

// ── shared by the readers ──────────────────────────────────────────────────────

export function refuseImport(format: DetectedFormat | "detect", message: string, target: string): TrentError {
  return new TrentError({ code: EXIT.USAGE, operation: `fleet.import.${format}`, message, target });
}

/** The agent id a host name becomes, or a typed refusal when it cannot be a Trent id. */
export function agentIdFrom(format: ForeignFormat, name: string, target: string): string {
  const id = name.trim();
  if (!SAFE_AGENT_ID.test(id)) throw refuseImport(format, `agent name "${id}" cannot be a Trent agent id (letters, digits, dot, underscore, dash)`, target);
  return id;
}

/**
 * The seat prompt of a body the exporter wrote (its `## Seat prompt` section, up to the next
 * `## ` heading), or the whole body when it is not one of ours. `exported` says which.
 */
export function seatPromptOf(body: string): { prompt: string; exported: boolean } {
  const lines = body.split("\n");
  const start = lines.findIndex((line) => line.trim() === SEAT_PROMPT_HEADING);
  if (start < 0) return { prompt: body.trim(), exported: false };
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return { prompt: (end < 0 ? rest : rest.slice(0, end)).join("\n").trim(), exported: true };
}

/** Every `<root>/<...>/SKILL.md` under a skills directory, nested any depth, slug = its directory name. */
export function readSkillTree(root: string, hostRoot: string, notCarried: string[]): ForeignSkill[] {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];
  const out: ForeignSkill[] = [];
  const walk = (dir: string): void => {
    const file = path.join(dir, SKILL_FILE);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      // A directory holding SKILL.md is a skill; what sits under it is its bundle, not more skills.
      const slug = path.basename(dir);
      const source = path.relative(hostRoot, file);
      if (SKILL_NAME_PATTERN.test(slug)) out.push({ slug, content: fs.readFileSync(file, "utf8"), dir, source });
      else notCarried.push(`skill ${source}: directory name "${slug}" cannot be a Trent skill name; not imported`);
      return;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name));
    }
  };
  walk(root);
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * A host's server entry (Claude `.mcp.json`, Codex `[mcp_servers.x]`, Hermes `mcp.json`) as the
 * profile stores it. Trent's own `trent mcp serve` entry is not a server to add and is noted; a
 * literal value under a secret-looking env name is replaced by `${NAME}` and noted without the
 * value; a name the profile cannot hold, or one that would shadow a built-in tool, is noted.
 */
export function normaliseMcpEntry(name: string, raw: unknown): { entry?: McpServerConfig; notes: string[] } {
  const notes: string[] = [];
  if (!isRecord(raw)) return { notes: [`mcp server ${name}: entry is not an object; not imported`] };
  const args = Array.isArray(raw.args) ? raw.args.map(String) : [];
  if (typeof raw.command === "string" && TRENT_SERVE_ARGS.every((arg, i) => args[i] === arg)) {
    return { notes: [`mcp server ${name}: \`${raw.command} ${args.join(" ")}\` is Trent's own server (trent mcp serve); the profile is the server, so nothing is added`] };
  }
  if (!MCP_SERVER_NAME_PATTERN.test(name)) return { notes: [`mcp server ${name}: name must match ${String(MCP_SERVER_NAME_PATTERN)}; not imported`] };
  if (isBuiltinToolName(name)) return { notes: [`mcp server ${name}: name collides with a built-in Trent tool; not imported`] };
  const env: Record<string, string> = {};
  if (isRecord(raw.env)) {
    for (const [key, value] of Object.entries(raw.env)) {
      const text = String(value);
      if (isSecretName(key) && !containsTemplate(text)) {
        env[key] = `\${${key}}`;
        notes.push(`mcp server ${name}: env ${key} carried a literal value; stored as \${${key}}, export the variable before use`);
      } else env[key] = text;
    }
  }
  const headers: Record<string, string> = {};
  if (isRecord(raw.headers)) for (const [key, value] of Object.entries(raw.headers)) headers[key] = String(value);
  const candidate = typeof raw.url === "string" ? { transport: "http", url: raw.url, headers } : typeof raw.command === "string" ? { transport: "stdio", command: raw.command, args, env } : undefined;
  if (candidate === undefined) return { notes: [`mcp server ${name}: neither a command nor a url; not imported`] };
  const parsed = McpServerConfigSchema.safeParse(candidate);
  if (!parsed.success) return { notes: [`mcp server ${name}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "entry"}: ${i.message}`).join("; ")}; not imported`] };
  return { entry: parsed.data, notes };
}

/** Keeps the names `ToolsetSchema` knows, in order, once each. */
export function knownToolsets(names: readonly string[]): string[] {
  const out: string[] = [];
  const known: readonly string[] = ToolsetSchema.options;
  for (const name of names) if (known.includes(name) && !out.includes(name)) out.push(name);
  return out;
}

/**
 * Grants against denials, the stricter reading: a toolset the host both allows (one tool of it)
 * and denies (another tool of it) is denied whole, and the note says so; a toolset is coarser
 * than a tool, and an import never widens what the host had.
 */
export function resolveGrants(granted: readonly string[], denied: readonly string[]): { toolsets: string[]; denied: string[]; notes: string[] } {
  const deny = knownToolsets(denied);
  const notes = knownToolsets(granted).filter((t) => deny.includes(t)).map((t) => `toolset ${t}: the host allows one of its tools and denies another; Trent grants a toolset whole, so it is denied`);
  return { toolsets: knownToolsets(granted).filter((t) => !deny.includes(t)), denied: deny, notes };
}

// ── detection and dispatch ─────────────────────────────────────────────────────

function hasAgentFiles(dir: string, sub: readonly string[], ext: string): boolean {
  const agents = path.join(dir, ...sub);
  return fs.existsSync(agents) && fs.statSync(agents).isDirectory() && fs.readdirSync(agents).some((f) => f.endsWith(ext));
}

/** What the path is, from what is on disk; `undefined` when it is none of the four. */
export function detectForeignFormat(target: string): DetectedFormat | undefined {
  if (!fs.existsSync(target)) return undefined;
  if (fs.statSync(target).isFile()) {
    if (target.endsWith(".tar.gz") || target.endsWith(".tgz")) return "hermes";
    const parent = path.basename(path.dirname(target));
    const grand = path.basename(path.dirname(path.dirname(target)));
    if (target.endsWith(".md") && parent === "agents" && grand === ".claude") return "claude";
    if (target.endsWith(".toml") && parent === "agents" && grand === ".codex") return "codex";
    if (path.basename(target) === "agent.json") return "trent";
    return undefined;
  }
  if (fs.existsSync(path.join(target, "agent.json"))) return "trent";
  if (fs.existsSync(path.join(target, "distribution.yaml"))) return "hermes";
  if (hasAgentFiles(target, [".claude", "agents"], ".md")) return "claude";
  if (hasAgentFiles(target, [".codex", "agents"], ".toml")) return "codex";
  return undefined;
}

/** Reads the agent with the named reader, or the detected one. */
export async function readForeignAgent(target: string, format?: ForeignFormat): Promise<ForeignAgent> {
  const chosen = format ?? detectForeignFormat(target);
  if (chosen === undefined || chosen === "trent") {
    throw refuseImport("detect", `${target} is not a Claude subagent (.claude/agents/<name>.md), a Codex agent (.codex/agents/<name>.toml), a Hermes profile distribution (distribution.yaml or .tar.gz) or a Trent bundle (agent.json)`, target);
  }
  // Dynamic so the readers may import this file's helpers without a module cycle.
  if (chosen === "claude") return (await import("./import-claude.js")).readClaudeAgent(target);
  if (chosen === "codex") return (await import("./import-codex.js")).readCodexAgent(target);
  return (await import("./import-hermes.js")).readHermesProfile(target);
}

// ── the import itself ──────────────────────────────────────────────────────────

export interface McpScanOutcome {
  readonly scanRan: boolean;
  readonly reason?: string;
  readonly findings: McpScanFinding[];
}

/** Where the profile keeps its servers: the config manager, or a test's map. */
export interface McpServerSink {
  has(name: string): boolean;
  set(name: string, entry: McpServerConfig): void;
}

export interface ImportForeignInput {
  readonly versions: AgentVersions;
  readonly target: string;
  readonly format?: ForeignFormat;
  readonly profile: ImportProfile;
  /** The profile's configured model: the version needs one and the host's tier is not carried. */
  readonly model: AgentDefinition["model"];
  readonly mcpServers: McpServerSink;
  /** Store a server the scan flagged, as `trent mcp add --allow-flagged` does. */
  readonly allowFlagged?: boolean;
  /** The install-time scan; defaults to connecting and listing tools, as `trent mcp add` does. */
  readonly scanServer?: (name: string, entry: McpServerConfig) => Promise<McpScanOutcome>;
}

export interface ImportedSkill {
  readonly slug: string;
  readonly status: SkillStatus;
  /** Scanner categories, never the matched text. */
  readonly findings: string[];
  /** `written`, or `kept` when the profile already held a skill of that name. */
  readonly outcome: "written" | "kept";
}

export interface ImportedMcpServer {
  readonly name: string;
  readonly outcome: "added" | "refused" | "kept";
  readonly scanRan: boolean;
  readonly reason?: string;
  readonly findings: McpScanFinding[];
}

export interface ImportForeignResult {
  readonly format: ForeignFormat;
  readonly version: AgentVersionRow;
  readonly skills: ImportedSkill[];
  readonly mcpServers: ImportedMcpServer[];
  readonly notCarried: string[];
  readonly sources: string[];
  readonly recordFile: string;
}

/** Connects once, lists the tools and scans them; unreachable is an outcome, not an error. */
async function defaultScan(name: string, entry: McpServerConfig): Promise<McpScanOutcome> {
  let connection;
  try {
    connection = await connectMcpServer(name, entry, { env: process.env });
  } catch (error) {
    return { scanRan: false, reason: connectFailureReason(error), findings: [] };
  }
  try {
    return { scanRan: true, findings: scanMcpTools(await connection.listTools()) };
  } catch (error) {
    return { scanRan: false, reason: `tools/list failed: ${connectFailureReason(error)}`, findings: [] };
  } finally {
    await connection.close();
  }
}

/** Every text file of a skill's bundle directories, for the scan; the SKILL.md is scanned by the caller. */
function bundleTexts(dir: string | undefined): string[] {
  if (dir === undefined) return [];
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name !== SKILL_FILE) out.push(fs.readFileSync(full, "utf8"));
    }
  };
  walk(dir);
  return out;
}

function writeSkill(profile: ImportProfile, skill: ForeignSkill): ImportedSkill {
  const findings = new Set<string>(SecurityScan.scan(skill.content).findings);
  for (const text of bundleTexts(skill.dir)) for (const reason of SecurityScan.scan(text).findings) findings.add(reason);
  const status: SkillStatus = findings.size === 0 ? "active" : "quarantined";
  const list = [...findings].sort();
  if (findSkillRecord(profile.skillsDir, skill.slug) !== null) return { slug: skill.slug, status, findings: list, outcome: "kept" };
  const { fields, body } = parseFrontmatter(skill.content);
  const tags = fields.tags ? fields.tags.split(",").map((t) => t.trim()).filter((t) => t.length > 0) : undefined;
  const file = writeSkillRecord(profile.skillsDir, {
    name: skill.slug,
    ...(fields.name ? { title: fields.name } : {}),
    description: fields.description ?? "",
    ...(fields.category ? { category: fields.category } : {}),
    ...(fields.version ? { version: fields.version } : {}),
    ...(fields.author ? { author: fields.author } : {}),
    ...(tags === undefined ? {} : { tags }),
    instructions: body,
    // Untrusted content: the lowest tier the agent may still edit, declared as imported, and
    // quarantined with the category when the scan spoke. Whatever the file claimed is not honoured.
    trust: "community",
    createdBy: "import",
    status,
    quarantineReason: status === "quarantined" ? `import scan: ${list.join("; ")}` : null,
  });
  if (skill.dir !== undefined) {
    for (const entry of fs.readdirSync(skill.dir, { withFileTypes: true })) {
      if (entry.isDirectory()) fs.cpSync(path.join(skill.dir, entry.name), path.join(path.dirname(file), entry.name), { recursive: true });
    }
  }
  return { slug: skill.slug, status, findings: list, outcome: "written" };
}

async function addServer(input: ImportForeignInput, server: ForeignMcpServer): Promise<ImportedMcpServer> {
  if (input.mcpServers.has(server.name)) return { name: server.name, outcome: "kept", scanRan: false, findings: [] };
  const scan = await (input.scanServer ?? defaultScan)(server.name, server.entry);
  const flagged = scan.findings.length > 0;
  const base = { name: server.name, scanRan: scan.scanRan, ...(scan.reason === undefined ? {} : { reason: scan.reason }), findings: scan.findings };
  if (flagged && input.allowFlagged !== true) return { ...base, outcome: "refused" };
  input.mcpServers.set(server.name, { ...server.entry, scanRan: scan.scanRan, ...(flagged ? { flagged: scan.findings } : {}) });
  return { ...base, outcome: "added" };
}

function writeRecord(input: ImportForeignInput, agent: ForeignAgent, version: AgentVersionRow, toolsets: readonly string[], skills: readonly ImportedSkill[]): string {
  fs.mkdirSync(input.profile.agentsDir, { recursive: true });
  const recordFile = path.join(input.profile.agentsDir, `${agent.agentId}.json`);
  const existing = fs.existsSync(recordFile) ? (JSON.parse(fs.readFileSync(recordFile, "utf8")) as Record<string, unknown>) : {};
  const cents = typeof existing.budget_cap_per_run_cents === "number" ? existing.budget_cap_per_run_cents : (input.profile.budgetCapCents ?? 100);
  const slugs = skills.map((s) => s.slug).sort();
  const record = {
    id: agent.agentId,
    name: typeof existing.name === "string" ? existing.name : agent.name,
    category: typeof existing.category === "string" ? existing.category : "specialized",
    modelPolicy: typeof existing.modelPolicy === "string" ? existing.modelPolicy : "balanced",
    installed_at: typeof existing.installed_at === "string" ? existing.installed_at : new Date().toISOString(),
    // Never seated until a person promotes the candidate and deploys it.
    active: false,
    tools: toolsets.map((name) => ({ name, purpose: `${name} toolset (imported from ${agent.format} as version ${version.version})` })),
    skills: slugs,
    installed_skills: slugs,
    budget_cap_per_run_cents: cents,
    budget_cap_per_run: cents / 100,
    imported_version: version.version,
    imported_from: { format: agent.format, target: input.target, sources: agent.sources, description: agent.description, denied: agent.denied, not_carried: agent.notCarried },
  };
  fs.writeFileSync(recordFile, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return recordFile;
}

export async function importForeignAgent(input: ImportForeignInput): Promise<ImportForeignResult> {
  const agent = await readForeignAgent(input.target, input.format);
  try {
    const promptScan = SecurityScan.scan(agent.prompt);
    if (!promptScan.safe) {
      throw new TrentError({ code: EXIT.USAGE, operation: "fleet.import.securityScan", message: `Security scan refused the prompt in ${agent.sources[0] ?? input.target}: ${promptScan.findings.join("; ")}`, target: input.target });
    }
    const skills = agent.skills.map((skill) => writeSkill(input.profile, skill));
    const servers: ImportedMcpServer[] = [];
    for (const server of agent.mcpServers) servers.push(await addServer(input, server));
    // A reader grants `mcp` for the servers it read; when every one of them was refused, nothing is there to reach.
    const mcpReachable = agent.mcpServers.length === 0 || servers.some((s) => s.outcome !== "refused");
    const toolsets = knownToolsets(agent.toolsets.filter((t) => t !== "mcp" || mcpReachable));
    const definition: AgentDefinition = { prompt: agent.prompt, model: input.model, toolsets, skills: agent.skills.map((s) => ({ slug: s.slug, content: s.content })) };
    const version = await input.versions.createCandidate(agent.agentId, definition);
    const notCarried = [...agent.notCarried, ...SEAT_FIELDS_NO_HOST_HAS];
    const recordFile = writeRecord(input, { ...agent, notCarried }, version, toolsets, skills);
    return { format: agent.format, version, skills, mcpServers: servers, notCarried, sources: agent.sources, recordFile };
  } finally {
    agent.cleanup();
  }
}
