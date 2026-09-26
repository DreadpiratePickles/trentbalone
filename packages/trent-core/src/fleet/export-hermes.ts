/**
 * W5 — `fleet export --target hermes`: a seat, or a pack, as Hermes profile distributions
 * (https://hermes-agent.nousresearch.com/docs/user-guide/profile-distributions; the installed
 * Hermes's `hermes_cli/profile_distribution.py` and `profiles.py` say what is read):
 *
 *   <dir>/distribution.yaml     name (`trent-<id>`), version, description, env_requires (the
 *                               `trent connect` env names of the seat's providers, no values),
 *                               distribution_owned (so `hermes profile install <dir>` copies only
 *                               the profile's files, never the plain bundle beside them)
 *   <dir>/SOUL.md               the pack persona, the seat prompt, what Trent asks before doing,
 *                               the skills index
 *   <dir>/config.yaml           platform_toolsets.cli: the seat's toolsets as Hermes names them,
 *                               one to one where the names are shared, plus the `trent` server;
 *                               agent.disabled_toolsets: the seat's denied toolsets;
 *                               mcp_servers.trent: `trent mcp serve --stdio --profile <p>`
 *   <dir>/mcp.json              the same server in the Agent Plugins shape Hermes's plugin
 *                               loader validates (`hermes_cli/agent_plugins.py`)
 *   <dir>/README.md, .env.EXAMPLE
 *   <dir>/skills/<slug>/        the skills in the Agent Skills layout, bundle directories kept
 *   <dir>/<name>.tar.gz         the profile under one top-level directory, for `hermes profile
 *                               import <archive>`
 *   <dir>/agent.json            the plain bundle, so `fleet import <dir>` restores the record
 *
 * A pack writes one profile per member under `<dir>/<id>/`. `renderHermesProfile` is the pure
 * function over the bundle; everything else is the disk. Memory never travels: Hermes
 * hard-excludes `memories/`, and the brain stays with the running Trent the server points at.
 */
import fs from "node:fs";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";

import { connectProvider, type ConnectProviderId } from "../connect/providers.js";
import { ALWAYS_ON_ADAPTERS } from "../tools/index.js";
import type { AgentBundle } from "./export.js";
import { approvalRules, describeAgent, planHostExport, skillsIndex, trentServerEntry, writeHostSkill, type HostExportInput, type SkippedAgent } from "./export-host.js";
import type { FleetPack } from "./FleetPacks.js";
import { tarGzDirectory } from "./targz.js";

export const HERMES_MCP_SERVER_NAME = "trent";
const MANIFEST = "distribution.yaml";
const SOUL = "SOUL.md";
const CONFIG = "config.yaml";
const MCP_JSON = "mcp.json";
const README = "README.md";
const ENV_EXAMPLE = ".env.EXAMPLE";
const SKILLS_DIR = "skills";
const AGENT_PLUGINS_MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
/** What `hermes profile install` copies; the plain bundle and the archive are not the profile's. */
const DISTRIBUTION_OWNED: readonly string[] = [MANIFEST, SOUL, CONFIG, MCP_JSON, README, ENV_EXAMPLE, SKILLS_DIR];
const PROFILE_NAME_PREFIX = "trent-";
const PROFILE_NAME_MAX = 64;

/**
 * Trent toolset -> the Hermes toolset of the same capability (`toolsets.py` in the Hermes
 * source). The shared names map to themselves; four Hermes spells differently; `null` means
 * Hermes has no toolset of its own for it and the seat reaches it through the `trent` server only,
 * which is also what a toolset absent from this table gets. Keyed by string so a toolset another
 * wave adds to the enum lands as "MCP only" until it is named here; the test holds the table to
 * `ToolsetSchema.options` so the omission cannot outlive the wave.
 */
export const HERMES_TOOLSET_NAMES: Readonly<Record<string, string | null>> = {
  file_ops: "file",
  terminal: "terminal",
  web: "web",
  browser: "browser",
  code: "code_execution",
  vision: "vision",
  memory: "memory",
  delegation: "delegation",
  cron: "cronjob",
  skills: "skills",
  plugins: null,
  mcp: null,
  human: "clarify",
  media: null,
  business: null,
  social: null,
  // [P2-9] Hermes's own A2A client is its a2a platform plugin, configured under `a2a_agents` rather than
  // enabled as a toolset; the exported seat reaches Trent's through the trent server.
  a2a: null,
};

/** The `trent connect` providers a toolset executes against; a toolset absent here needs none. */
export const CONNECT_PROVIDERS_BY_TOOLSET: Readonly<Record<string, readonly ConnectProviderId[]>> = {
  business: ["stripe", "google", "square", "twilio"],
  social: ["buffer", "meta", "bluesky"],
};

/** `trent-<id>`, within Hermes's `[a-z0-9][a-z0-9_-]{0,63}`; never one of its reserved names. */
export function hermesProfileName(agentId: string): string {
  const body = agentId.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-");
  return `${PROFILE_NAME_PREFIX}${body}`.slice(0, PROFILE_NAME_MAX).replace(/-+$/, "");
}

export interface RenderHermesOptions {
  readonly persona?: string;
  readonly pack?: FleetPack;
  readonly descriptions: ReadonlyMap<string, string>;
  readonly profile?: string;
  readonly command?: string;
}

export interface HermesProfileFiles {
  readonly name: string;
  /** Profile-relative path -> content, every file the distribution owns except the skills. */
  readonly files: Readonly<Record<string, string>>;
}

interface EnvRequirement {
  name: string;
  description: string;
  required: false;
}

function hermesToolsets(toolsets: readonly string[]): string[] {
  const out = new Set<string>();
  for (const toolset of toolsets) {
    const name = HERMES_TOOLSET_NAMES[toolset];
    if (name !== null && name !== undefined) out.add(name);
  }
  return [...out];
}

function envRequires(bundle: AgentBundle): EnvRequirement[] {
  const out: EnvRequirement[] = [{ name: "TRENT_HOME", description: "Where the Trent profile lives that `trent mcp serve` reads; unset means ~/.trent.", required: false }];
  const seen = new Set<ConnectProviderId>();
  for (const toolset of bundle.seat?.toolsets ?? bundle.toolsets) {
    for (const id of CONNECT_PROVIDERS_BY_TOOLSET[toolset] ?? []) {
      if (seen.has(id)) continue;
      seen.add(id);
      const provider = connectProvider(id);
      for (const field of provider.fields) {
        out.push({ name: field.env, description: `${provider.name}: ${field.label}. Lives in the Trent profile's secrets, written by \`trent connect ${id}\`; Trent does not read this profile's .env.`, required: false });
      }
    }
  }
  return out;
}

/** The same shape Hermes generates from `env_requires` when a distribution ships none. */
function envExample(requirements: readonly EnvRequirement[]): string {
  const lines = ["# Environment variables this Hermes distribution names. None is read from this file by Trent:", "# connect the accounts with `trent connect <provider>` in the Trent profile instead.", ""];
  for (const requirement of requirements) lines.push(`# ${requirement.description}`, "# (optional)", `# ${requirement.name}=`, "");
  return `${lines.join("\n").trimEnd()}\n`;
}

function soul(bundle: AgentBundle, options: RenderHermesOptions): string {
  const title = bundle.seat?.name ?? bundle.agentId;
  const lines = [`# ${title} (Trent seat \`${bundle.agentId}\`, version ${String(bundle.version)})`, ""];
  if (options.persona !== undefined && options.pack !== undefined) lines.push(`## Persona: ${options.pack.name}`, "", options.persona, "");
  lines.push("## Seat prompt", "", bundle.prompt.trim(), "", ...approvalRules(bundle, HERMES_MCP_SERVER_NAME, `this profile's \`${CONFIG}\` (\`mcp_servers.${HERMES_MCP_SERVER_NAME}\`)`), "", ...skillsIndex(bundle.skills, options.descriptions, SKILLS_DIR), "");
  return lines.join("\n");
}

function readme(bundle: AgentBundle, name: string, options: RenderHermesOptions): string {
  const seat = bundle.seat;
  return [
    `# ${name}`,
    "",
    `A Hermes profile of the Trent seat \`${bundle.agentId}\` (version ${String(bundle.version)}, prompt ${bundle.promptHash.slice(0, 12)}), exported by \`trent fleet export ${options.pack?.id ?? bundle.agentId} --target hermes\`.`,
    "",
    "```bash",
    `hermes profile install <this directory> --name ${name}`,
    `hermes profile import ${name}.tar.gz`,
    "```",
    "",
    `\`${CONFIG}\` sets no model: the host chooses. Its \`mcp_servers.${HERMES_MCP_SERVER_NAME}\` entry starts \`trent mcp serve --stdio\`, so \`trent\` must be on the PATH of the machine running Hermes, with its own profile and secrets; the seat's Trent tools appear as \`mcp__${HERMES_MCP_SERVER_NAME}__<tool>\`.`,
    "",
    seat === undefined ? "This agent carries no seat record." : `Toolsets: ${seat.toolsets.join(", ")}. Denied: ${seat.denied.length === 0 ? "none" : seat.denied.join(", ")}. Per-run cap ${String(seat.budgetCents)} cents, enforced by the running Trent, not by Hermes.`,
    "",
  ].join("\n");
}

/** The distribution's text files for one bundle; skills are written from the store separately. */
export function renderHermesProfile(bundle: AgentBundle, options: RenderHermesOptions): HermesProfileFiles {
  const name = hermesProfileName(bundle.agentId);
  const requirements = envRequires(bundle);
  const toolsets = bundle.seat?.toolsets ?? bundle.toolsets;
  const manifest = {
    name,
    version: `${String(bundle.version)}.0.0`,
    description: `${describeAgent(bundle.agentId).replace(/\s+/g, " ").trim()} (Trent seat ${bundle.agentId}, version ${String(bundle.version)}, prompt ${bundle.promptHash.slice(0, 12)})`,
    env_requires: requirements,
    distribution_owned: [...DISTRIBUTION_OWNED],
  };
  const server = trentServerEntry(options);
  const config = {
    // Trent's always-on adapters are Hermes toolsets of the same name; the server's bare name is the documented alias of its `mcp-trent` toolset.
    platform_toolsets: { cli: [...new Set([...hermesToolsets(toolsets), ...ALWAYS_ON_ADAPTERS, HERMES_MCP_SERVER_NAME])] },
    agent: { disabled_toolsets: hermesToolsets(bundle.seat?.denied ?? []) },
    mcp_servers: { [HERMES_MCP_SERVER_NAME]: server },
  };
  const mcp = { $schema: AGENT_PLUGINS_MCP_SCHEMA, mcpServers: { [HERMES_MCP_SERVER_NAME]: { type: "stdio", ...server } } };
  return {
    name,
    files: {
      [MANIFEST]: stringifyYaml(manifest),
      [SOUL]: soul(bundle, options),
      [CONFIG]: `# Trent seat ${bundle.agentId}, version ${String(bundle.version)}: the seat's toolsets as Hermes names them, and the trent server.\n${stringifyYaml(config)}`,
      [MCP_JSON]: `${JSON.stringify(mcp, null, 2)}\n`,
      [README]: readme(bundle, name, options),
      [ENV_EXAMPLE]: envExample(requirements),
    },
  };
}

export interface HermesExportedProfile {
  readonly agentId: string;
  readonly name: string;
  /** The profile directory: `distribution.yaml` at its root, for `hermes profile install`. */
  readonly dir: string;
  /** The archive for `hermes profile import`. */
  readonly archive: string;
}

export interface ExportHermesResult {
  readonly agents: string[];
  readonly skipped: SkippedAgent[];
  readonly files: string[];
  readonly pack?: string;
  readonly persona: boolean;
  readonly profiles: HermesExportedProfile[];
}

function ownedPath(relative: string): boolean {
  return relative === SKILLS_DIR || relative.startsWith(`${SKILLS_DIR}/`) || DISTRIBUTION_OWNED.includes(relative);
}

export async function exportHermesProfiles(input: HostExportInput): Promise<ExportHermesResult> {
  const plan = await planHostExport(input, "fleet.export.hermes", (agentId, pack) => (pack === undefined ? input.dir : path.join(input.dir, agentId)));
  const files = [...plan.files];
  const profiles: HermesExportedProfile[] = [];
  for (const member of plan.members) {
    const descriptions = new Map<string, string>();
    for (const skill of member.skills) {
      // The plain bundle's `skills/<slug>/SKILL.md` IS the profile skill, rewritten in the Agent Skills shape.
      const written = writeHostSkill(path.join(member.bundleDir, SKILLS_DIR), skill.slug, skill.content, input.skillsDir);
      descriptions.set(skill.slug, written.description);
      for (const file of written.files) if (!files.includes(file)) files.push(file);
    }
    const rendered = renderHermesProfile(member.bundle, { ...(plan.persona === undefined ? {} : { persona: plan.persona }), ...(plan.pack === undefined ? {} : { pack: plan.pack }), descriptions, ...(input.profile === undefined ? {} : { profile: input.profile }), ...(input.command === undefined ? {} : { command: input.command }) });
    for (const [relative, content] of Object.entries(rendered.files)) {
      const file = path.join(member.bundleDir, relative);
      fs.writeFileSync(file, content, "utf8");
      files.push(file);
    }
    const archive = path.join(member.bundleDir, `${rendered.name}.tar.gz`);
    fs.writeFileSync(archive, tarGzDirectory(member.bundleDir, { rootName: rendered.name, include: ownedPath }));
    files.push(archive);
    profiles.push({ agentId: member.agentId, name: rendered.name, dir: member.bundleDir, archive });
  }
  return { agents: plan.members.map((m) => m.agentId), skipped: plan.skipped, files, ...(plan.pack === undefined ? {} : { pack: plan.pack.id }), persona: plan.persona !== undefined, profiles };
}
