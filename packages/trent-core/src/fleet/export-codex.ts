/**
 * W5 — `fleet export --target codex`: a seat, or a pack, as the files a Codex CLI user drops
 * into a project (https://learn.chatgpt.com/docs/agent-configuration/subagents.md,
 * https://learn.chatgpt.com/docs/config-file/config-reference, https://agents.md/):
 *
 *   <dir>/.codex/agents/<id>.toml   one custom agent per exported agent: `name`, `description`,
 *                                   `developer_instructions` (pack persona, seat prompt, what
 *                                   Trent asks before doing, skills index) and, because an agent
 *                                   file is a config layer for the spawned session, the
 *                                   `[mcp_servers.trent]` table; no `model`, which is the host's
 *   <dir>/AGENTS.md                 the project guidance: every exported agent, the approval rules,
 *                                   the skills index, and the `[mcp_servers.trent]` snippet for
 *                                   the parent session's `~/.codex/config.toml`
 *   <dir>/.agents/skills/<slug>/    the skills where Codex looks, in the Agent Skills layout
 *   <dir>/agent.json + skills/      (one seat) the plain bundle, so `fleet import <dir>` restores it
 *   <dir>/agents/<id>/              (a pack) one plain bundle per member
 *
 * OpenAI says of custom agents that "the format may evolve as authoring and sharing mature";
 * the keys written here are exactly the ones its documentation names today, and nothing else.
 */
import fs from "node:fs";
import path from "node:path";

import type { AgentBundle } from "./export.js";
import { approvalPreamble, approvalRules, describeAgent, enforcementNote, planHostExport, seatGates, skillsIndex, trentServerEntry, writeHostSkill, type HostExportInput, type SkippedAgent } from "./export-host.js";
import type { FleetPack } from "./FleetPacks.js";

export const CODEX_MCP_SERVER_NAME = "trent";
const AGENTS_DIR = path.join(".codex", "agents");
const AGENTS_MD = "AGENTS.md";
const SKILLS_ROOT = path.join(".agents", "skills");
const CONFIG_FILE = "~/.codex/config.toml";

/** A TOML basic string on one line: quotes, backslashes and control characters escaped. */
export function tomlString(value: string): string {
  const escaped = value.replace(/[\\"\u0000-\u001f\u007f]/g, (ch) => {
    switch (ch) {
      case "\\":
        return "\\\\";
      case '"':
        return '\\"';
      case "\n":
        return "\\n";
      case "\t":
        return "\\t";
      case "\r":
        return "\\r";
      default:
        return `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
    }
  });
  return `"${escaped}"`;
}

/**
 * A TOML multi-line basic string. Backslashes are escaped first, so no line can end in the
 * line-ending backslash that would swallow the newline; a run of three quotes is broken with an
 * escape; control characters other than tab and newline are escaped.
 */
function tomlMultiline(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"""/g, '""\\"')
    .replace(/\r/g, "\\r")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `"""\n${escaped}\n"""`;
}

function tomlArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

/** The `[mcp_servers.trent]` table, the same in the agent file and the AGENTS.md snippet. */
export function codexServerTable(options: Pick<HostExportInput, "profile" | "command">): string {
  const server = trentServerEntry(options);
  return [
    `[mcp_servers.${CODEX_MCP_SERVER_NAME}]`,
    `command = ${tomlString(server.command)}`,
    `args = ${tomlArray(server.args)}`,
    "",
    `[mcp_servers.${CODEX_MCP_SERVER_NAME}.env]`,
    ...Object.entries(server.env).map(([key, value]) => `${key} = ${tomlString(value)}`),
  ].join("\n");
}

export interface RenderCodexOptions {
  readonly persona?: string;
  readonly pack?: FleetPack;
  readonly descriptions: ReadonlyMap<string, string>;
  readonly profile?: string;
  readonly command?: string;
}

function instructions(bundle: AgentBundle, options: RenderCodexOptions): string {
  const body: string[] = [];
  if (options.persona !== undefined && options.pack !== undefined) body.push(`## Persona: ${options.pack.name}`, "", options.persona, "");
  body.push("## Seat prompt", "", bundle.prompt.trim(), "", ...approvalRules(bundle, CODEX_MCP_SERVER_NAME, `this file's \`[mcp_servers.${CODEX_MCP_SERVER_NAME}]\``), "", ...skillsIndex(bundle.skills, options.descriptions, SKILLS_ROOT.split(path.sep).join("/")));
  return body.join("\n");
}

/** The custom agent file for one bundle: TOML text, byte-stable for the same bundle. */
export function renderCodexAgent(bundle: AgentBundle, options: RenderCodexOptions): string {
  return [
    `# Trent seat ${bundle.agentId}, version ${String(bundle.version)}, prompt ${bundle.promptHash.slice(0, 12)}: a Codex custom agent.`,
    "# OpenAI documents this format as one that may evolve; the keys below are the ones it names today.",
    `name = ${tomlString(bundle.agentId)}`,
    `description = ${tomlString(describeAgent(bundle.agentId).replace(/\s+/g, " ").trim())}`,
    `developer_instructions = ${tomlMultiline(instructions(bundle, options))}`,
    "",
    codexServerTable(options),
    "",
  ].join("\n");
}

/** `AGENTS.md` for the project: the agents, the server snippet, the rules, the skills. */
export function renderCodexAgentsMd(bundles: readonly AgentBundle[], options: RenderCodexOptions): string {
  const slugs = [...new Set(bundles.flatMap((bundle) => bundle.skills))].sort();
  const lines = [
    "# Trent agents in this project",
    "",
    `Exported by \`trent fleet export ${options.pack?.id ?? bundles[0]?.agentId ?? ""} --target codex\`. Each agent below is a Codex custom agent under \`.codex/agents/\`; its Trent tools run on the \`${CODEX_MCP_SERVER_NAME}\` MCP server that the agent file and the snippet below name. OpenAI says the custom-agent format may evolve, so regenerate these files from Trent rather than editing them by hand.`,
    "",
    "## Agents",
    "",
    ...bundles.map((bundle) => `- \`${bundle.agentId}\` (\`.codex/agents/${bundle.agentId}.toml\`): ${describeAgent(bundle.agentId).replace(/\s+/g, " ").trim()}`),
    "",
    `## The ${CODEX_MCP_SERVER_NAME} MCP server`,
    "",
    `Add this to \`${CONFIG_FILE}\` so the parent session has the same tools; every agent file carries it already. \`trent\` must be on the PATH with its own profile and secrets.`,
    "",
    "```toml",
    codexServerTable(options),
    "```",
    "",
    "## What Trent asks before doing",
    "",
    ...approvalPreamble(CODEX_MCP_SERVER_NAME),
  ];
  for (const bundle of bundles) {
    const gates = seatGates(bundle);
    if (gates.length > 0) lines.push("", `### ${bundle.agentId}`, ...gates);
  }
  lines.push("", enforcementNote(`\`[mcp_servers.${CODEX_MCP_SERVER_NAME}]\``), "", ...skillsIndex(slugs, options.descriptions, SKILLS_ROOT.split(path.sep).join("/")), "");
  return lines.join("\n");
}

export interface ExportCodexResult {
  readonly agents: string[];
  readonly skipped: SkippedAgent[];
  readonly files: string[];
  readonly pack?: string;
  readonly persona: boolean;
}

export async function exportCodexAgents(input: HostExportInput): Promise<ExportCodexResult> {
  const plan = await planHostExport(input, "fleet.export.codex", (agentId, pack) => (pack === undefined ? input.dir : path.join(input.dir, "agents", agentId)));
  fs.mkdirSync(path.join(input.dir, AGENTS_DIR), { recursive: true });
  const files = [...plan.files];
  const descriptions = new Map<string, string>();
  const written = new Set<string>();
  const options: RenderCodexOptions = { ...(plan.persona === undefined ? {} : { persona: plan.persona }), ...(plan.pack === undefined ? {} : { pack: plan.pack }), descriptions, ...(input.profile === undefined ? {} : { profile: input.profile }), ...(input.command === undefined ? {} : { command: input.command }) };
  for (const member of plan.members) {
    for (const skill of member.skills) {
      if (written.has(skill.slug)) continue;
      written.add(skill.slug);
      // The project's `.agents/skills/` is the union of the members'; the plain bundle keeps its own copy.
      const out = writeHostSkill(path.join(input.dir, SKILLS_ROOT), skill.slug, skill.content, input.skillsDir);
      descriptions.set(skill.slug, out.description);
      for (const file of out.files) if (!files.includes(file)) files.push(file);
    }
    const agentFile = path.join(input.dir, AGENTS_DIR, `${member.agentId}.toml`);
    fs.writeFileSync(agentFile, renderCodexAgent(member.bundle, options), "utf8");
    files.push(agentFile);
  }
  const agentsMd = path.join(input.dir, AGENTS_MD);
  fs.writeFileSync(agentsMd, renderCodexAgentsMd(plan.members.map((m) => m.bundle), options), "utf8");
  files.push(agentsMd);
  return { agents: plan.members.map((m) => m.agentId), skipped: plan.skipped, files, ...(plan.pack === undefined ? {} : { pack: plan.pack.id }), persona: plan.persona !== undefined };
}
