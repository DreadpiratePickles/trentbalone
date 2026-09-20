/**
 * W5 — what every host renderer shares: which agents a target names (a seat, an installed agent,
 * or a pack's members), the pack persona from the brain, the application's own description of a
 * seat, the approval rules read from the code, the skills index, and a skill written in the
 * Agent Skills layout with Trent's fields nested under `metadata.trent`.
 *
 * The Hermes and Codex renderers (`export-hermes.ts`, `export-codex.ts`) build on this; the
 * Claude renderer (`export-claude.ts`, U5) predates it and still carries its own copies of the
 * same pieces, which a later commit can point here. Nothing in this file writes a host file: it
 * exports the plain bundle per member and hands the renderer the bundles.
 */
import fs from "node:fs";
import path from "node:path";

import { AGENT_CATALOG } from "../agents/index.js";
import { EXIT, TrentError } from "../errors/index.js";
import { HARDLINE_RULES } from "../governance/hardline.js";
import { findSkillRecord, parseFrontmatter, renderFrontmatter } from "../skills/skill-store.js";
import { ALWAYS_APPROVE } from "../tools/terminal/index.js";
import { CORE_ROLES } from "./AgentInstaller.js";
import type { AgentVersions } from "./AgentVersions.js";
import { exportAgent, SKILL_BUNDLE_DIRS, type AgentBundle } from "./export.js";
import { FLEET_PACKS, type FleetPack } from "./FleetPacks.js";
import { isSeatRole } from "./seat-capabilities.js";

const SKILL_FILE = "SKILL.md";
/** Trent's own frontmatter fields, nested under `metadata.trent` when the skill leaves. */
const TRENT_SKILL_FIELDS: readonly string[] = ["category", "trust", "version", "author", "tags", "status", "created_by", "promoted_at", "quarantine_reason"];

/** The input every host renderer takes. */
export interface HostExportInput {
  readonly versions: AgentVersions;
  /** A seat or installed agent id, or a pack id. */
  readonly target: string;
  readonly dir: string;
  /** Where `brain/system/persona-<pack>.md` is read from. */
  readonly profileDir: string;
  readonly skillsDir?: string;
  readonly agentsDir?: string;
  /** The Trent profile the host's server entry names; omitted means the default profile. */
  readonly profile?: string;
  /** The executable the host's server entry names. Defaults to `trent`. */
  readonly command?: string;
}

export interface SkippedAgent {
  readonly agentId: string;
  readonly reason: string;
}

/** One exported member: its plain bundle on disk and the skill bodies its version carries. */
export interface HostMember {
  readonly agentId: string;
  readonly bundle: AgentBundle;
  readonly bundleDir: string;
  readonly skills: readonly { readonly slug: string; readonly content: string }[];
}

export interface HostExportPlan {
  readonly pack?: FleetPack;
  readonly persona?: string;
  readonly members: HostMember[];
  readonly skipped: SkippedAgent[];
  /** Absolute paths the plain bundles wrote. */
  readonly files: string[];
}

export function packOf(target: string): FleetPack | undefined {
  return FLEET_PACKS[target.toLowerCase().trim()];
}

function hasRecord(agentsDir: string | undefined, agentId: string): boolean {
  return agentsDir !== undefined && fs.existsSync(path.join(agentsDir, `${agentId}.json`));
}

/** `persona-<pack>.md` under the brain's system tier, when the pack has been installed with one. */
export function readPersona(profileDir: string, pack: FleetPack): string | undefined {
  const file = path.join(profileDir, "brain", "system", `persona-${pack.id}.md`);
  if (!fs.existsSync(file)) return undefined;
  const text = fs.readFileSync(file, "utf8").trim();
  return text === "" ? undefined : text;
}

/** When the host should delegate to this agent, in the application's own words. */
export function describeAgent(agentId: string): string {
  const core = CORE_ROLES[agentId];
  if (core !== undefined) return core.description;
  const catalog = AGENT_CATALOG.find((agent) => agent.id === agentId);
  if (catalog !== undefined) return catalog.whenToUse || catalog.specialties;
  return `The ${agentId} agent of a Trent profile.`;
}

/** The server entry every host points at: `trent mcp serve --stdio [--profile <p>]`. */
export function trentServerEntry(input: Pick<HostExportInput, "profile" | "command">): { command: string; args: string[]; env: Record<string, string> } {
  return {
    command: input.command ?? "trent",
    args: ["mcp", "serve", "--stdio", ...(input.profile === undefined ? [] : ["--profile", input.profile])],
    env: { TRENT_QUEUE_FALLBACK: "disabled" },
  };
}

/** The general half of the gate text: the `needs_approval` result, the hardline rules, the floors. */
export function approvalPreamble(server: string): string[] {
  const floors = ALWAYS_APPROVE.map(([, label]) => `\`${label}\``).join(", ");
  return [
    `Every Trent tool runs on the \`${server}\` MCP server, behind Trent's gates. A call the gates hold comes back with status \`needs_approval\` and an approval id; nothing runs until the founder settles it with \`trent approvals approve <id>\` (or \`trent approvals reject <id>\`), after which the same call, with the same arguments, runs once.`,
    "",
    `Trent refuses outright, at every autonomy level: ${HARDLINE_RULES.map((rule) => `\`${rule.id}\``).join(", ")}; any \`approvals.deny\` glob in the profile; and the approval floors ${floors}.`,
  ];
}

/** The seat's own half: its manifest gates, cap, tier and suite; nothing when the bundle has no seat record. */
export function seatGates(bundle: AgentBundle): string[] {
  const seat = bundle.seat;
  if (seat === undefined) return [];
  return [
    "",
    `This seat's manifest gates: ${seat.approvalGates.length === 0 ? "none beyond the floors" : seat.approvalGates.map((gate) => `\`${gate}\``).join(", ")}.`,
    `Per-run cap: ${String(seat.budgetCents)} cents${seat.modelTier === undefined ? "" : `; model tier \`${seat.modelTier}\``}${seat.evalSuiteId === undefined ? "" : `; eval suite \`${seat.evalSuiteId}\``}.`,
  ];
}

/** Where enforcement really lives; `pointer` is the host file that names the server. */
export function enforcementNote(pointer: string): string {
  return `The cap, the floors, the evals and the version pins are enforced by the running Trent that ${pointer} points at, not by this file.`;
}

/**
 * The lines the host is told about Trent's gates for one agent, read from the rules rather than
 * restated: the preamble, the seat's own gates, and where enforcement lives.
 */
export function approvalRules(bundle: AgentBundle, server: string, pointer: string): string[] {
  return ["## What Trent asks before doing", "", ...approvalPreamble(server), ...seatGates(bundle), "", enforcementNote(pointer)];
}

/** The skills as a bulleted index; `root` is where the host finds them. */
export function skillsIndex(slugs: readonly string[], descriptions: ReadonlyMap<string, string>, root: string): string[] {
  if (slugs.length === 0) return ["## Skills", "", "This seat carries no skills."];
  return ["## Skills", "", ...slugs.map((slug) => `- **${slug}**: ${descriptions.get(slug) ?? ""} (\`${root}/${slug}/${SKILL_FILE}\`)`)];
}

/**
 * SKILL.md in the Agent Skills shape under `<root>/<slug>/`: `name` and `description` on top,
 * Trent's own fields under `metadata.trent`, the body as it was. A canonical skill is copied with
 * its bundle directories; a skill the version carries but the store no longer holds is written
 * from the version. Returns the files written and the description the index uses.
 */
export function writeHostSkill(root: string, slug: string, content: string, skillsDir: string | undefined): { files: string[]; description: string } {
  const target = path.join(root, slug);
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

/**
 * Resolves the target to its members, refuses one that is nothing, reads the persona, and writes
 * each member's plain bundle where `bundleDirFor` says (so `fleet import` reads it back). A pack
 * member that is neither a seat nor installed is skipped by name, never invented.
 */
export async function planHostExport(input: HostExportInput, operation: string, bundleDirFor: (agentId: string, pack: FleetPack | undefined) => string): Promise<HostExportPlan> {
  const refuse = (message: string): TrentError => new TrentError({ code: EXIT.USAGE, operation, message, target: input.target });
  const pack = packOf(input.target);
  const candidates = pack === undefined ? [input.target] : pack.agents;
  if (pack === undefined && !isSeatRole(input.target) && !hasRecord(input.agentsDir, input.target)) {
    throw refuse(`"${input.target}" is neither a pack nor a seat nor an installed agent of this profile`);
  }
  const persona = pack === undefined ? undefined : readPersona(input.profileDir, pack);
  const members: HostMember[] = [];
  const skipped: SkippedAgent[] = [];
  const files: string[] = [];
  for (const agentId of candidates) {
    if (!isSeatRole(agentId) && !hasRecord(input.agentsDir, agentId)) {
      skipped.push({ agentId, reason: "neither a seat of the application nor an agent installed in this profile" });
      continue;
    }
    const bundleDir = bundleDirFor(agentId, pack);
    const exported = await exportAgent({ versions: input.versions, agentId, dir: bundleDir, ...(input.skillsDir === undefined ? {} : { skillsDir: input.skillsDir }), ...(input.agentsDir === undefined ? {} : { agentsDir: input.agentsDir }) });
    files.push(...exported.files);
    members.push({ agentId, bundle: exported.bundle, bundleDir, skills: exported.skills });
  }
  if (members.length === 0) throw refuse(`nothing to export: ${skipped.map((s) => s.agentId).join(", ")} ${skipped[0]?.reason ?? ""}`.trim());
  return { ...(pack === undefined ? {} : { pack }), ...(persona === undefined ? {} : { persona }), members, skipped, files };
}
