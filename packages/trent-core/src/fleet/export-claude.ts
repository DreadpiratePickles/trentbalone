/**
 * U5 — `fleet export --target claude`: a seat, or a pack, as the files a Claude Code user drops
 * into a project (Grok Build reads the same layout, research 1d):
 *
 *   <dir>/.claude/agents/<id>.md    one subagent per exported agent: frontmatter `name`,
 *                                   `description`, `tools` (the MCP tool names the `trent` server
 *                                   exposes for the seat's toolsets, as `mcp__trent__<tool>`); no
 *                                   `model`, which is the host's to choose; body = pack persona,
 *                                   seat prompt, what Trent asks before doing, skills index
 *   <dir>/.mcp.json                 the `trent` server entry: `trent mcp serve --stdio --profile <p>`
 *   <dir>/skills/<slug>/            the skills in the Agent Skills layout, bundle directories kept,
 *                                   Trent's own fields under `metadata.trent`
 *   <dir>/agent.json + skills/      (one seat) the plain bundle, so `fleet import <dir>` restores it
 *   <dir>/agents/<id>/              (a pack) one plain bundle per member
 *
 * What the file cannot carry is said in it: the cap, the floors, the evals and the version pins
 * are enforced by the running Trent the `.mcp.json` points at, never by the host.
 */
import fs from "node:fs";
import path from "node:path";

import { AGENT_CATALOG } from "../agents/index.js";
import { EXIT, TrentError } from "../errors/index.js";
import { HARDLINE_RULES } from "../governance/hardline.js";
import { mcpToolNamesFor } from "../mcp-server/toolset-tools.js";
import { findSkillRecord, parseFrontmatter, renderFrontmatter } from "../skills/skill-store.js";
import { ALWAYS_APPROVE } from "../tools/terminal/index.js";
import { CORE_ROLES } from "./AgentInstaller.js";
import type { AgentVersions } from "./AgentVersions.js";
import { exportAgent, SKILL_BUNDLE_DIRS, type AgentBundle } from "./export.js";
import { FLEET_PACKS, type FleetPack } from "./FleetPacks.js";
import { isSeatRole } from "./seat-capabilities.js";

export const CLAUDE_MCP_SERVER_NAME = "trent";
const AGENTS_DIR = path.join(".claude", "agents");
const SKILLS_DIR = "skills";
const SKILL_FILE = "SKILL.md";
/** Trent's own frontmatter fields, nested under `metadata.trent` when the skill leaves. */
const TRENT_SKILL_FIELDS: readonly string[] = ["category", "trust", "version", "author", "tags", "status", "created_by", "promoted_at", "quarantine_reason"];

/** `mcp__trent__<tool>`: how Claude Code names a tool of the `trent` server (docs, MCP tool naming). */
export function claudeToolName(tool: string): string {
  return `mcp__${CLAUDE_MCP_SERVER_NAME}__${tool}`;
}

export interface ExportClaudeInput {
  readonly versions: AgentVersions;
  /** A seat or installed agent id, or a pack id. */
  readonly target: string;
  readonly dir: string;
  /** Where `brain/system/persona-<pack>.md` is read from. */
  readonly profileDir: string;
  readonly skillsDir?: string;
  readonly agentsDir?: string;
  /** The profile `.mcp.json` names; omitted means the default profile. */
  readonly profile?: string;
  /** The executable `.mcp.json` names. Defaults to `trent`. */
  readonly command?: string;
}

export interface SkippedMember {
  readonly agentId: string;
  readonly reason: string;
}

export interface ExportClaudeResult {
  readonly agents: string[];
  readonly skipped: SkippedMember[];
  readonly files: string[];
  readonly pack?: string;
  readonly persona: boolean;
}

function refuse(message: string, target: string): TrentError {
  return new TrentError({ code: EXIT.USAGE, operation: "fleet.export.claude", message, target });
}

function packOf(target: string): FleetPack | undefined {
  return FLEET_PACKS[target.toLowerCase().trim()];
}

function hasRecord(agentsDir: string | undefined, agentId: string): boolean {
  return agentsDir !== undefined && fs.existsSync(path.join(agentsDir, `${agentId}.json`));
}

/** `persona-<pack>.md` under the brain's system tier, when the pack has been installed with one. */
function readPersona(profileDir: string, pack: FleetPack): string | undefined {
  const file = path.join(profileDir, "brain", "system", `persona-${pack.id}.md`);
  if (!fs.existsSync(file)) return undefined;
  const text = fs.readFileSync(file, "utf8").trim();
  return text === "" ? undefined : text;
}

/** The subagent's `description`: when the host should delegate to it, in the application's own words. */
function describe(agentId: string): string {
  const core = CORE_ROLES[agentId];
  if (core !== undefined) return core.description;
  const catalog = AGENT_CATALOG.find((agent) => agent.id === agentId);
  if (catalog !== undefined) return catalog.whenToUse || catalog.specialties;
  return `The ${agentId} agent of a Trent profile.`;
}

/** The lines the host is told about Trent's gates: read from the rules, not restated. */
function approvalRules(bundle: AgentBundle): string[] {
  const seat = bundle.seat;
  const floors = ALWAYS_APPROVE.map(([, label]) => `\`${label}\``).join(", ");
  const lines = [
    "## What Trent asks before doing",
    "",
    `Every tool above runs on the \`${CLAUDE_MCP_SERVER_NAME}\` MCP server, behind Trent's gates. A call the gates hold comes back with status \`needs_approval\` and an approval id; nothing runs until the founder settles it with \`trent approvals approve <id>\` (or \`trent approvals reject <id>\`), after which the same call, with the same arguments, runs once.`,
    "",
    `Trent refuses outright, at every autonomy level: ${HARDLINE_RULES.map((rule) => `\`${rule.id}\``).join(", ")}; any \`approvals.deny\` glob in the profile; and the approval floors ${floors}.`,
  ];
  if (seat !== undefined) {
    lines.push("", `This seat's manifest gates: ${seat.approvalGates.length === 0 ? "none beyond the floors" : seat.approvalGates.map((gate) => `\`${gate}\``).join(", ")}.`);
    lines.push(`Per-run cap: ${String(seat.budgetCents)} cents${seat.modelTier === undefined ? "" : `; model tier \`${seat.modelTier}\``}${seat.evalSuiteId === undefined ? "" : `; eval suite \`${seat.evalSuiteId}\``}.`);
  }
  lines.push("", "The cap, the floors, the evals and the version pins are enforced by the running Trent this project's `.mcp.json` points at, not by this file.");
  return lines;
}

function skillsIndex(bundle: AgentBundle, descriptions: Map<string, string>): string[] {
  if (bundle.skills.length === 0) return ["## Skills", "", "This seat carries no skills."];
  return ["## Skills", "", ...bundle.skills.map((slug) => `- **${slug}**: ${descriptions.get(slug) ?? ""} (\`${SKILLS_DIR}/${slug}/${SKILL_FILE}\`)`)];
}

function renderAgent(bundle: AgentBundle, options: { persona?: string; pack?: FleetPack; descriptions: Map<string, string> }): string {
  const toolsets = bundle.seat?.toolsets ?? bundle.toolsets;
  const fields: Record<string, string> = {
    name: bundle.agentId,
    // Double-quoted so a colon or a quote in the application's own words stays valid YAML for the host.
    description: JSON.stringify(describe(bundle.agentId).replace(/\s+/g, " ").trim()),
    tools: mcpToolNamesFor(toolsets).map(claudeToolName).join(", "),
  };
  const body: string[] = [];
  if (options.persona !== undefined && options.pack !== undefined) body.push(`## Persona: ${options.pack.name}`, "", options.persona, "");
  body.push("## Seat prompt", "", bundle.prompt.trim(), "", ...approvalRules(bundle), "", ...skillsIndex(bundle, options.descriptions), "");
  return renderFrontmatter(fields, `\n${body.join("\n")}`);
}

/**
 * SKILL.md in the Agent Skills shape: `name` and `description` on top, Trent's own fields under
 * `metadata.trent`, the body as it was. A canonical skill is copied with its bundle directories;
 * a skill the version carries but the store no longer holds is written from the version.
 */
function writeSkill(dir: string, slug: string, content: string, skillsDir: string | undefined): { files: string[]; description: string } {
  const target = path.join(dir, SKILLS_DIR, slug);
  fs.mkdirSync(target, { recursive: true });
  const record = skillsDir === undefined ? null : findSkillRecord(skillsDir, slug);
  const source = record?.dir === null || record?.dir === undefined ? undefined : record.dir;
  const parsed = parseFrontmatter(source === undefined ? content : fs.readFileSync(path.join(source, SKILL_FILE), "utf8"));
  const body = parsed.body;
  const description = parsed.fields.description || record?.description || body.split("\n").find((line) => line.startsWith("> "))?.slice(2).trim() || "";
  const fields: Record<string, string> = { name: slug, description };
  for (const [key, value] of Object.entries(parsed.fields)) {
    if (key === "name" || key === "description") continue;
    fields[TRENT_SKILL_FIELDS.includes(key) ? `metadata.trent.${key}` : key] = value;
  }
  const file = path.join(target, SKILL_FILE);
  fs.writeFileSync(file, renderFrontmatter(fields, body), "utf8");
  const files = [file];
  if (source !== undefined) {
    for (const bundle of SKILL_BUNDLE_DIRS) {
      const from = path.join(source, bundle);
      if (!fs.existsSync(from) || !fs.statSync(from).isDirectory()) continue;
      fs.cpSync(from, path.join(target, bundle), { recursive: true });
      files.push(path.join(target, bundle));
    }
  }
  return { files, description };
}

function writeMcpJson(dir: string, input: ExportClaudeInput): string {
  const args = ["mcp", "serve", "--stdio", ...(input.profile === undefined ? [] : ["--profile", input.profile])];
  const file = path.join(dir, ".mcp.json");
  const entry = { command: input.command ?? "trent", args, env: { TRENT_QUEUE_FALLBACK: "disabled" } };
  fs.writeFileSync(file, `${JSON.stringify({ mcpServers: { [CLAUDE_MCP_SERVER_NAME]: entry } }, null, 2)}\n`, "utf8");
  return file;
}

export async function exportClaudeAgents(input: ExportClaudeInput): Promise<ExportClaudeResult> {
  const pack = packOf(input.target);
  const members = pack === undefined ? [input.target] : pack.agents;
  if (pack === undefined && !isSeatRole(input.target) && !hasRecord(input.agentsDir, input.target)) {
    throw refuse(`"${input.target}" is neither a pack nor a seat nor an installed agent of this profile`, input.target);
  }
  const persona = pack === undefined ? undefined : readPersona(input.profileDir, pack);
  fs.mkdirSync(path.join(input.dir, AGENTS_DIR), { recursive: true });
  const files: string[] = [];
  const agents: string[] = [];
  const skipped: SkippedMember[] = [];
  const descriptions = new Map<string, string>();
  const written = new Set<string>();

  for (const agentId of members) {
    if (!isSeatRole(agentId) && !hasRecord(input.agentsDir, agentId)) {
      skipped.push({ agentId, reason: "neither a seat of the application nor an agent installed in this profile" });
      continue;
    }
    const bundleDir = pack === undefined ? input.dir : path.join(input.dir, "agents", agentId);
    const exported = await exportAgent({ versions: input.versions, agentId, dir: bundleDir, ...(input.skillsDir === undefined ? {} : { skillsDir: input.skillsDir }), ...(input.agentsDir === undefined ? {} : { agentsDir: input.agentsDir }) });
    files.push(...exported.files);
    const bundle = exported.bundle;
    for (const skill of exported.skills) {
      if (written.has(skill.slug)) continue;
      written.add(skill.slug);
      // One seat: the plain bundle's `skills/<slug>/SKILL.md` IS the project skill, rewritten in the
      // Agent Skills shape. A pack: the project's `skills/` is the union of the members'.
      const skillOut = writeSkill(input.dir, skill.slug, skill.content, input.skillsDir);
      descriptions.set(skill.slug, skillOut.description);
      for (const file of skillOut.files) if (!files.includes(file)) files.push(file);
    }
    const agentFile = path.join(input.dir, AGENTS_DIR, `${agentId}.md`);
    fs.writeFileSync(agentFile, renderAgent(bundle, { ...(persona === undefined ? {} : { persona }), ...(pack === undefined ? {} : { pack }), descriptions }), "utf8");
    files.push(agentFile);
    agents.push(agentId);
  }
  if (agents.length === 0) throw refuse(`nothing to export: ${skipped.map((s) => s.agentId).join(", ")} ${skipped[0]?.reason ?? ""}`.trim(), input.target);
  files.push(writeMcpJson(input.dir, input));
  return { agents, skipped, files, ...(pack === undefined ? {} : { pack: pack.id }), persona: persona !== undefined };
}
