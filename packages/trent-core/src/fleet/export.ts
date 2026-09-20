/**
 * T4.2 — an agent leaves and enters a profile as a directory:
 *
 *   <dir>/agent.json                 the version bundle: prompt text, model, toolsets, hashes, version,
 *                                    and [U5] the seat record (toolsets, denied, approval gates, budget
 *                                    cents, model tier, eval suite id) the host cannot enforce but the
 *                                    next Trent can
 *   <dir>/skills/<slug>/SKILL.md     one file per skill the version carries
 *   <dir>/skills/<slug>/<bundle>/    [U5] the skill's `references/ scripts/ assets/ tools/` when the
 *                                    profile's skills dir is given; they used to be dropped
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
import { findSkillRecord } from "../skills/skill-store.js";
import type { AgentDefinition, AgentVersionRow } from "../store/StorePort.js";
import type { AgentVersions } from "./AgentVersions.js";
import { isSeatRole, seatCapability } from "./seat-capabilities.js";

export const AGENT_BUNDLE_SCHEMA = "trent.agent/1";
const AGENT_FILE = "agent.json";
const SKILLS_DIR = "skills";
const SKILL_FILE = "SKILL.md";
/** A slug is one path segment; anything else would escape `skills/`. */
const SAFE_SLUG = /^[a-z0-9][a-z0-9._-]*$/i;
const SAFE_AGENT_ID = /^[a-z0-9][a-z0-9._-]*$/i;

/** A skill's bundle directories, in the Agent Skills layout plus `tools/`. */
export const SKILL_BUNDLE_DIRS: readonly string[] = ["references", "scripts", "assets", "tools"];

/**
 * [U5] What makes the seat a seat (`seat-capabilities.ts`), carried so the next Trent restores the
 * record. `modelTier` and `evalSuiteId` exist for the application's seats only; a custom agent has
 * a name, toolsets and a cap. Cents are INTEGER cents.
 */
const seatRecordSchema = z.object({
  name: z.string(),
  toolsets: z.array(z.string()),
  denied: z.array(z.string()),
  approvalGates: z.array(z.string()),
  budgetCents: z.number().int().nonnegative(),
  modelTier: z.string().optional(),
  evalSuiteId: z.string().optional(),
});
export type SeatRecord = z.infer<typeof seatRecordSchema>;

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
  /** Optional so a bundle written before U5 still imports. */
  seat: seatRecordSchema.optional(),
});
export type AgentBundle = z.infer<typeof bundleSchema>;

export interface ExportAgentInput {
  readonly versions: AgentVersions;
  readonly agentId: string;
  readonly dir: string;
  /** [U5] The profile's skills dir; when given, each skill's bundle directories travel too. */
  readonly skillsDir?: string;
  /** [U5] The profile's agents dir; a custom agent's record is where its cap and name live. */
  readonly agentsDir?: string;
}

export interface ExportAgentResult {
  readonly agentId: string;
  readonly version: number;
  readonly versionId: string;
  /** Absolute paths written, `agent.json` first. */
  readonly files: string[];
  /** [U5] What `agent.json` holds, for a renderer that builds on the bundle. */
  readonly bundle: AgentBundle;
  /** [U5] The skill bodies the version carries, slug and content. */
  readonly skills: readonly { readonly slug: string; readonly content: string }[];
}

interface InstalledRecordSlice {
  readonly name?: unknown;
  readonly tools?: unknown;
  readonly budget_cap_per_run_cents?: unknown;
  readonly seat?: unknown;
}

function readInstalledRecord(agentsDir: string | undefined, agentId: string): InstalledRecordSlice | undefined {
  if (agentsDir === undefined) return undefined;
  const file = path.join(agentsDir, `${agentId}.json`);
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as InstalledRecordSlice;
  } catch {
    return undefined;
  }
}

/**
 * [U5] The seat record for the bundle: the application's manifest for one of its seats; for a
 * custom agent the record it was imported with, else what its installed record says. Never
 * invented: a custom agent with no record carries none.
 */
export function seatRecordFor(agentId: string, agentsDir?: string, toolsets: readonly string[] = []): SeatRecord | undefined {
  if (isSeatRole(agentId)) {
    const seat = seatCapability(agentId);
    return {
      name: seat.name,
      toolsets: [...seat.toolsets],
      denied: [...seat.denied],
      approvalGates: [...seat.approvalGates],
      budgetCents: seat.budgetCents,
      modelTier: seat.modelTier,
      evalSuiteId: seat.evalSuiteId,
    };
  }
  const record = readInstalledRecord(agentsDir, agentId);
  if (record === undefined) return undefined;
  const restored = seatRecordSchema.safeParse(record.seat);
  if (restored.success) return restored.data;
  const cents = typeof record.budget_cap_per_run_cents === "number" && Number.isInteger(record.budget_cap_per_run_cents) ? record.budget_cap_per_run_cents : undefined;
  if (cents === undefined) return undefined;
  return { name: typeof record.name === "string" ? record.name : agentId, toolsets: [...toolsets], denied: [], approvalGates: [], budgetCents: cents };
}

/** Every file under `dir`, relative to it, in a stable order. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full).map((f) => path.join(entry.name, f)));
    else if (entry.isFile()) out.push(entry.name);
  }
  return out;
}

/** [U5] Copies a skill's bundle directories beside its SKILL.md; returns the files written. */
function copySkillBundle(skillsDir: string | undefined, slug: string, skillDir: string): string[] {
  if (skillsDir === undefined) return [];
  const record = findSkillRecord(skillsDir, slug);
  if (record?.dir === null || record?.dir === undefined) return [];
  const written: string[] = [];
  for (const bundle of SKILL_BUNDLE_DIRS) {
    const source = path.join(record.dir, bundle);
    if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) continue;
    const target = path.join(skillDir, bundle);
    fs.cpSync(source, target, { recursive: true });
    written.push(...filesUnder(target).map((f) => path.join(target, f)));
  }
  return written;
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
  const seat = seatRecordFor(row.agentId, input.agentsDir, row.toolsets);
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
    ...(seat === undefined ? {} : { seat }),
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
    files.push(file, ...copySkillBundle(input.skillsDir, skill.slug, skillDir));
  }
  return { agentId: row.agentId, version: row.version, versionId: row.id, files, bundle, skills: row.definition.skills.map((s) => ({ slug: s.slug, content: s.content })) };
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
  const existing = fs.existsSync(recordFile) ? (JSON.parse(fs.readFileSync(recordFile, "utf8")) as Record<string, unknown>) : {};
  // [U5] The cap the bundle carries wins, then what the profile already had, then the profile's default.
  const cents = bundle.seat?.budgetCents ?? (typeof existing.budget_cap_per_run_cents === "number" ? existing.budget_cap_per_run_cents : (input.profile.budgetCapCents ?? 100));
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
    budget_cap_per_run_cents: cents,
    budget_cap_per_run: cents / 100,
    imported_version: version.version,
    // [U5] The seat record travels with the agent, so the next export carries it unchanged.
    ...(bundle.seat === undefined ? {} : { seat: bundle.seat }),
  };
  fs.writeFileSync(recordFile, `${JSON.stringify(record, null, 2)}\n`, "utf8");

  return { version, inspected, skillsWritten, recordFile };
}
