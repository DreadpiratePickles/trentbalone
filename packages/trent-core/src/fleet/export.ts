/**
 * T4.2 — an agent leaves and enters a profile as a directory:
 *
 *   <dir>/agent.json                 the version bundle: prompt text, model, toolsets, hashes, version
 *   <dir>/skills/<slug>/SKILL.md     one file per skill the version carries
 *
 * `exportAgent` writes the live version (or the newest candidate, or a candidate it snapshots
 * from the profile when the agent was never versioned) so the same profile exports the same bytes
 * twice. `importAgent` reads the whole bundle, runs `SecurityScan` over every SKILL.md and over
 * the prompt, and refuses on any finding before a single write: the error names the file and the
 * scanner's category, never the offending text. What passes becomes a NEW candidate version —
 * never live; `fleet promote` is the human step — and the agent's record and skill files land in
 * the profile so `fleet deploy` can seat it.
 */

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

import { EXIT, TrentError } from "../errors/index.js";
import { SecurityScan } from "../skills/SecurityScan.js";
import type { AgentDefinition, AgentVersionRow } from "../store/StorePort.js";
import type { AgentVersions } from "./AgentVersions.js";

export const AGENT_BUNDLE_SCHEMA = "trent.agent/1";
const AGENT_FILE = "agent.json";
const SKILLS_DIR = "skills";
const SKILL_FILE = "SKILL.md";
/** A slug is one path segment; anything else would escape `skills/`. */
const SAFE_SLUG = /^[a-z0-9][a-z0-9._-]*$/i;
const SAFE_AGENT_ID = /^[a-z0-9][a-z0-9._-]*$/i;

const bundleSchema = z.object({
  schema: z.literal(AGENT_BUNDLE_SCHEMA),
  agentId: z.string().regex(SAFE_AGENT_ID),
  version: z.number().int().positive(),
  promptHash: z.string(),
  skillsHash: z.string(),
  model: z.object({ provider: z.string(), model: z.string() }),
  toolsets: z.array(z.string()),
  prompt: z.string(),
  skills: z.array(z.string().regex(SAFE_SLUG)),
});
export type AgentBundle = z.infer<typeof bundleSchema>;

export interface ExportAgentInput {
  readonly versions: AgentVersions;
  readonly agentId: string;
  readonly dir: string;
}

export interface ExportAgentResult {
  readonly agentId: string;
  readonly version: number;
  readonly versionId: string;
  /** Absolute paths written, `agent.json` first. */
  readonly files: string[];
}

/** The version an export represents: live, else the newest candidate, else a fresh snapshot. */
async function versionToExport(versions: AgentVersions, agentId: string): Promise<AgentVersionRow> {
  const live = await versions.liveVersion(agentId);
  if (live) return live;
  const candidate = (await versions.list(agentId)).find((v) => v.label === "candidate");
  return candidate ?? versions.createCandidate(agentId);
}

export async function exportAgent(input: ExportAgentInput): Promise<ExportAgentResult> {
  const row = await versionToExport(input.versions, input.agentId);
  const bundle: AgentBundle = {
    schema: AGENT_BUNDLE_SCHEMA,
    agentId: row.agentId,
    version: row.version,
    promptHash: row.promptHash,
    skillsHash: row.skillsHash,
    model: row.model,
    toolsets: row.toolsets,
    prompt: row.definition.prompt,
    skills: row.definition.skills.map((s) => s.slug).sort(),
  };
  fs.mkdirSync(input.dir, { recursive: true });
  const agentFile = path.join(input.dir, AGENT_FILE);
  fs.writeFileSync(agentFile, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  const files = [agentFile];
  for (const skill of row.definition.skills) {
    if (!SAFE_SLUG.test(skill.slug)) continue;
    const skillDir = path.join(input.dir, SKILLS_DIR, skill.slug);
    fs.mkdirSync(skillDir, { recursive: true });
    const file = path.join(skillDir, SKILL_FILE);
    fs.writeFileSync(file, skill.content, "utf8");
    files.push(file);
  }
  return { agentId: row.agentId, version: row.version, versionId: row.id, files };
}

/** Where an imported agent's record and skill files go, so `fleet deploy` can seat it. */
export interface ImportProfile {
  readonly agentsDir: string;
  readonly skillsDir: string;
  /** Per-run cap for the record, INTEGER CENTS. Defaults to 100. */
  readonly budgetCapCents?: number;
}

export interface ImportAgentInput {
  readonly versions: AgentVersions;
  readonly dir: string;
  readonly profile: ImportProfile;
}

export interface ImportAgentResult {
  readonly version: AgentVersionRow;
  /** Bundle-relative paths the scan covered. */
  readonly inspected: string[];
  /** Skill slugs whose files were written; ones already present are left alone. */
  readonly skillsWritten: string[];
  readonly recordFile: string;
}

function refused(operation: string, message: string, target: string): TrentError {
  return new TrentError({ code: EXIT.USAGE, operation, message, target });
}

/** Scans one file's text; a finding is reported by file and category, never by content. */
function scanOrRefuse(relative: string, content: string, dir: string): void {
  const scan = SecurityScan.scan(content);
  if (scan.safe) return;
  throw refused("fleet.import.securityScan", `Security scan refused ${relative}: ${scan.findings.join("; ")}`, dir);
}

function readBundle(dir: string): AgentBundle {
  const file = path.join(dir, AGENT_FILE);
  if (!fs.existsSync(file)) throw refused("fleet.import", `no ${AGENT_FILE} in ${dir}`, dir);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    throw refused("fleet.import", `${AGENT_FILE} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, dir);
  }
  const parsed = bundleSchema.safeParse(raw);
  if (!parsed.success) {
    throw refused("fleet.import", `${AGENT_FILE} does not match ${AGENT_BUNDLE_SCHEMA}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "root"}: ${i.message}`).join("; ")}`, dir);
  }
  return parsed.data;
}

export async function importAgent(input: ImportAgentInput): Promise<ImportAgentResult> {
  const bundle = readBundle(input.dir);
  const inspected: string[] = [AGENT_FILE];
  scanOrRefuse(AGENT_FILE, bundle.prompt, input.dir);

  // Every skill file is read and checked before anything is written or versioned.
  const skills: AgentDefinition["skills"] = [];
  for (const slug of bundle.skills) {
    const relative = path.join(SKILLS_DIR, slug, SKILL_FILE);
    const file = path.join(input.dir, relative);
    if (!fs.existsSync(file)) throw refused("fleet.import", `${AGENT_FILE} lists skill "${slug}" but ${relative} is missing`, input.dir);
    const content = fs.readFileSync(file, "utf8");
    inspected.push(relative);
    scanOrRefuse(relative, content, input.dir);
    skills.push({ slug, content });
  }

  const definition: AgentDefinition = { prompt: bundle.prompt, model: bundle.model, toolsets: bundle.toolsets, skills };
  const version = await input.versions.createCandidate(bundle.agentId, definition);

  fs.mkdirSync(input.profile.skillsDir, { recursive: true });
  const skillsWritten: string[] = [];
  for (const skill of skills) {
    const file = path.join(input.profile.skillsDir, `${skill.slug}.md`);
    if (fs.existsSync(file)) continue;
    fs.writeFileSync(file, skill.content, "utf8");
    skillsWritten.push(skill.slug);
  }

  fs.mkdirSync(input.profile.agentsDir, { recursive: true });
  const recordFile = path.join(input.profile.agentsDir, `${bundle.agentId}.json`);
  const slugs = skills.map((s) => s.slug).sort();
  const cents = input.profile.budgetCapCents ?? 100;
  const existing = fs.existsSync(recordFile) ? (JSON.parse(fs.readFileSync(recordFile, "utf8")) as Record<string, unknown>) : {};
  const record = {
    id: bundle.agentId,
    name: typeof existing.name === "string" ? existing.name : bundle.agentId,
    category: typeof existing.category === "string" ? existing.category : "specialized",
    modelPolicy: typeof existing.modelPolicy === "string" ? existing.modelPolicy : "balanced",
    installed_at: typeof existing.installed_at === "string" ? existing.installed_at : new Date().toISOString(),
    active: typeof existing.active === "boolean" ? existing.active : false,
    tools: bundle.toolsets.map((name) => ({ name, purpose: `${name} toolset (imported with version ${bundle.version})` })),
    skills: slugs,
    installed_skills: slugs,
    budget_cap_per_run_cents: typeof existing.budget_cap_per_run_cents === "number" ? existing.budget_cap_per_run_cents : cents,
    budget_cap_per_run: (typeof existing.budget_cap_per_run_cents === "number" ? existing.budget_cap_per_run_cents : cents) / 100,
    imported_version: version.version,
  };
  fs.writeFileSync(recordFile, `${JSON.stringify(record, null, 2)}\n`, "utf8");

  return { version, inspected, skillsWritten, recordFile };
}
