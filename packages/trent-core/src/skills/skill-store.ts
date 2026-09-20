/**
 * The skill store. One directory, one on-disk format, two surfaces.
 *
 * Canonical form: `<skills>/[<category>/]<name>/SKILL.md`, frontmatter carrying name, description,
 * category, trust, version, author and tags, with optional `references/ scripts/ assets/` beside it.
 * It is the richer of the two forms that used to coexist here — the flat `<slug>.md|.json` file the
 * old `SkillsHub.install` wrote can express neither a trust tier, nor a category, nor a bundle — so
 * it is the one that survives, and the flat form converts into it losing nothing.
 *
 * Migration runs on read, so a profile written by any older surface heals itself the first time
 * either surface looks at it: the flat file is rendered into canonical form with an atomic
 * write-then-rename (0600 under 0700), the flat file is unlinked, and one line names the skill. A
 * second read finds no flat file and does nothing. A flat file whose canonical form already exists
 * is never overwritten, and a name that cannot be a canonical directory name is left exactly where
 * it is and still listed, so no skill is ever lost.
 */
import fs from "node:fs";
import path from "node:path";
import { NODE_IO, atomicWriteFileSync } from "../config/atomic-fs.js";
import { parseFrontmatter, renderFrontmatter } from "./frontmatter.js";
import { NO_USAGE, forgetSkillUsage, readSkillUsage } from "./usage.js";

// [U5] The parser and renderer live in `./frontmatter.ts`; every reader keeps importing them here.
export { parseFrontmatter, renderFrontmatter, type Frontmatter } from "./frontmatter.js";

export type SkillTrust = "builtin" | "official" | "trusted" | "community";

/**
 * [D3] The curator's lifecycle. `active` is advertised to seats; `stale` still is, and is the
 * warning that nothing has loaded it in a long time; `archived` is not advertised and is kept on
 * disk so it can be restored; `quarantined` is what an agent-authored skill gets when the
 * composed-skill scan flags it, and only a human clears that.
 */
export type SkillStatus = "active" | "stale" | "archived" | "quarantined";
export const SKILL_STATUSES: readonly SkillStatus[] = ["active", "stale", "archived", "quarantined"];
export const DEFAULT_SKILL_STATUS: SkillStatus = "active";

/**
 * [D3] Declared provenance, never inferred from telemetry. Only `agent` skills are eligible for
 * autonomous curation; `human` and `import` are reported and left alone until someone adopts them.
 */
export type SkillProvenance = "human" | "agent" | "import";
export const SKILL_PROVENANCES: readonly SkillProvenance[] = ["human", "agent", "import"];
/** A skill with nothing declared is treated as the founder's: the curator never touches it. */
export const DEFAULT_SKILL_PROVENANCE: SkillProvenance = "human";
export const SKILL_TRUST_TIERS: readonly SkillTrust[] = ["builtin", "official", "trusted", "community"];
export const BUNDLE_DIRS = ["references", "scripts", "assets"] as const;
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const SKILL_FILE = "SKILL.md";
export const SKILL_FILE_MODE = 0o600;
export const SKILL_DIR_MODE = 0o700;
export const DEFAULT_SKILL_CATEGORY = "general";
export const DEFAULT_SKILL_VERSION = "1.0.0";
/** What a person put in the profile: editable by the agent, unlike `builtin` and `official`. */
export const MIGRATED_SKILL_TRUST: SkillTrust = "trusted";

export interface SkillRecord {
  /** Slug: the directory name, or the flat file's base name. */
  name: string;
  /** Human title from the frontmatter or the first heading. */
  title: string;
  description: string;
  category: string;
  trust: SkillTrust;
  version: string;
  author: string;
  tags: string[];
  /** Directory holding SKILL.md, or null for a flat file that could not be migrated. */
  dir: string | null;
  /** SKILL.md, or the flat file. */
  file: string;
  /** SKILL.md body without frontmatter, or the flat file's instructions. */
  instructions: string;
  /** [D3] Lifecycle state. Absent frontmatter reads as `active`. */
  status: SkillStatus;
  /** [D3] Declared provenance. Absent frontmatter reads as `human`. */
  createdBy: SkillProvenance;
  /** [D3] When the skill entered the store, the aging baseline before anything has loaded it. */
  promotedAt: string | null;
  /** [D3] Why the composed-skill scan quarantined it; null unless `status` is `quarantined`. */
  quarantineReason: string | null;
  /** [D3] Loads by a seat's run, from the `.usage.json` sidecar. */
  useCount: number;
  /** [D3] The last of those loads. Null when nothing has loaded it. */
  lastUsedAt: string | null;
}

export interface SkillWriteInput {
  name: string;
  title?: string;
  description?: string;
  category?: string;
  trust?: SkillTrust;
  version?: string;
  author?: string;
  tags?: readonly string[];
  instructions: string;
  status?: SkillStatus;
  createdBy?: SkillProvenance;
  promotedAt?: string | null;
  quarantineReason?: string | null;
}

export interface SkillStoreOptions {
  /** Where the migration's one line per skill goes. Defaults to stderr. */
  onMigrate?: (line: string) => void;
}

/** The agent may only change skills it (or a person) authored: trusted and community. */
export function isMutable(trust: SkillTrust): boolean {
  return trust === "trusted" || trust === "community";
}

/** [D3] Whether a seat is told this skill exists. Archived and quarantined skills are not. */
export function isAdvertised(record: Pick<SkillRecord, "status">): boolean {
  return record.status === "active" || record.status === "stale";
}

/** [D3] The curator may age, archive and draft against declared agent skills, and nothing else. */
export function isCuratable(record: Pick<SkillRecord, "createdBy">): boolean {
  return record.createdBy === "agent";
}

function headingMeta(body: string, fallbackTitle: string): { title: string; description: string } {
  let title = "";
  let description = "";
  for (const line of body.split("\n")) {
    if (line.startsWith("# ") && !title) title = line.slice(2).trim();
    else if (line.startsWith("> ") && !description) description = line.slice(2).trim();
  }
  return { title: title || fallbackTitle, description };
}

function kindOf(target: string): "dir" | "file" | null {
  try {
    const stat = fs.statSync(target);
    return stat.isDirectory() ? "dir" : stat.isFile() ? "file" : null;
  } catch {
    return null;
  }
}

function splitTags(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
}

/** `<skills>/<name>` for the default category, `<skills>/<category>/<name>` otherwise. */
export function skillDirFor(skillsDir: string, name: string, category?: string): string {
  const folder = (category ?? "").trim();
  if (folder === "" || folder === DEFAULT_SKILL_CATEGORY) return path.join(skillsDir, name);
  return path.join(skillsDir, folder, name);
}

/** Dot entries are curator metadata — the ledger, the blob store, the usage sidecar — not skills. */
function isDotEntry(name: string): boolean {
  return name.startsWith(".");
}

function statusOf(raw: string | undefined): SkillStatus {
  return SKILL_STATUSES.includes(raw as SkillStatus) ? (raw as SkillStatus) : DEFAULT_SKILL_STATUS;
}

function provenanceOf(raw: string | undefined): SkillProvenance {
  return SKILL_PROVENANCES.includes(raw as SkillProvenance) ? (raw as SkillProvenance) : DEFAULT_SKILL_PROVENANCE;
}

function readCanonical(dir: string, name: string, fallbackCategory: string): SkillRecord | null {
  const file = path.join(dir, SKILL_FILE);
  if (kindOf(file) !== "file") return null;
  const { fields, body } = parseFrontmatter(fs.readFileSync(file, "utf8"));
  const meta = headingMeta(body, fields.name ?? name);
  const trust = SKILL_TRUST_TIERS.includes(fields.trust as SkillTrust)
    ? (fields.trust as SkillTrust)
    : "community";
  const tags = splitTags(fields.tags);
  return {
    status: statusOf(fields.status),
    createdBy: provenanceOf(fields.created_by),
    promotedAt: fields.promoted_at || null,
    quarantineReason: fields.quarantine_reason || null,
    ...NO_USAGE,
    name,
    title: fields.name || meta.title,
    description: fields.description || meta.description,
    category: fields.category || fallbackCategory,
    trust,
    version: fields.version || DEFAULT_SKILL_VERSION,
    author: fields.author || "community",
    tags: tags.length > 0 ? tags : [fields.category || fallbackCategory],
    dir,
    file,
    instructions: body,
  };
}

/** What the flat `<slug>.md` / `<slug>.json` form says about itself, read exactly as the loader read it. */
function readFlat(skillsDir: string, file: string): SkillRecord | null {
  const base = path.basename(file);
  const name = base.replace(/\.(md|json)$/, "");
  if (kindOf(file) !== "file") return null;
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  if (base.endsWith(".json")) {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return null;
    }
    const str = (key: string): string => (typeof raw[key] === "string" ? (raw[key] as string) : "");
    const tags = Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === "string") : [];
    return {
      status: DEFAULT_SKILL_STATUS,
      // A flat file predates the lifecycle and came from another surface: imported, not adopted.
      createdBy: "import",
      promotedAt: null,
      quarantineReason: null,
      ...NO_USAGE,
      name,
      title: str("name") || name,
      description: str("description"),
      category: tags[0] ?? DEFAULT_SKILL_CATEGORY,
      trust: MIGRATED_SKILL_TRUST,
      version: str("version") || DEFAULT_SKILL_VERSION,
      author: str("author") || "trent",
      tags,
      dir: null,
      file,
      instructions: str("instructions") || str("content"),
    };
  }
  // A flat `.md` the provisioner wrote is a bundled SKILL.md verbatim, Agent Skills frontmatter
  // included. That frontmatter is the skill's own metadata and the body is its instructions; a
  // flat file with no frontmatter is read from its heading and first quote, as it always was.
  const { fields, body } = parseFrontmatter(text);
  const meta = headingMeta(body, name);
  const category = fields.category || DEFAULT_SKILL_CATEGORY;
  const tags = splitTags(fields.tags);
  return {
    status: DEFAULT_SKILL_STATUS,
    createdBy: "import",
    promotedAt: null,
    quarantineReason: null,
    ...NO_USAGE,
    name,
    title: meta.title !== name ? meta.title : fields.name || name,
    description: fields.description || meta.description || `Skill for ${meta.title}`,
    category,
    trust: SKILL_TRUST_TIERS.includes(fields.trust as SkillTrust) ? (fields.trust as SkillTrust) : MIGRATED_SKILL_TRUST,
    version: fields.version || DEFAULT_SKILL_VERSION,
    author: fields.author || "community",
    tags: tags.length > 0 ? tags : [category],
    dir: null,
    file,
    instructions: body,
  };
}

/** Canonical skills at depth one and two, by slug. */
function canonicalRecords(skillsDir: string): Map<string, SkillRecord> {
  const out = new Map<string, SkillRecord>();
  for (const top of fs.readdirSync(skillsDir)) {
    if (isDotEntry(top)) continue;
    const topDir = path.join(skillsDir, top);
    if (kindOf(topDir) !== "dir") continue;
    const direct = readCanonical(topDir, top, DEFAULT_SKILL_CATEGORY);
    if (direct) {
      out.set(top, direct);
      continue;
    }
    for (const sub of fs.readdirSync(topDir)) {
      if (isDotEntry(sub)) continue;
      const subDir = path.join(topDir, sub);
      if (kindOf(subDir) !== "dir") continue;
      const entry = readCanonical(subDir, sub, top);
      if (entry && !out.has(sub)) out.set(sub, entry);
    }
  }
  return out;
}

/** Flat files at the top level, in readdir order, newest form (.json) before .md for one slug. */
function flatFiles(skillsDir: string): string[] {
  return fs
    .readdirSync(skillsDir)
    .filter((f) => !isDotEntry(f))
    .filter((f) => f.endsWith(".md") || f.endsWith(".json"))
    .filter((f) => kindOf(path.join(skillsDir, f)) === "file")
    .sort()
    .map((f) => path.join(skillsDir, f));
}

function migrationLine(record: SkillRecord, skillsDir: string, file: string): string {
  const from = path.relative(skillsDir, record.file);
  const to = path.relative(skillsDir, file);
  return `skills: migrated "${record.name}" from ${from} to ${to}`;
}

/**
 * Convert every flat skill that can be converted. Returns the slugs migrated, in order.
 * A slug that already has a canonical form, and a name a directory cannot carry, are left alone.
 */
export function migrateFlatSkills(skillsDir: string, options: SkillStoreOptions = {}): string[] {
  if (kindOf(skillsDir) !== "dir") return [];
  const files = flatFiles(skillsDir);
  if (files.length === 0) return [];
  const log = options.onMigrate ?? ((line: string) => process.stderr.write(`${line}\n`));
  const canonical = canonicalRecords(skillsDir);
  const migrated: string[] = [];
  for (const flat of files) {
    const record = readFlat(skillsDir, flat);
    if (record === null) continue;
    if (!SKILL_NAME_PATTERN.test(record.name)) continue;
    if (canonical.has(record.name)) continue;
    const file = writeSkillRecord(skillsDir, record);
    fs.unlinkSync(flat);
    canonical.set(record.name, { ...record, dir: path.dirname(file), file });
    migrated.push(record.name);
    log(migrationLine(record, skillsDir, file));
  }
  return migrated;
}

/** Every skill in the store, migrating the flat form on the way. Sorted by slug. */
export function listSkillRecords(skillsDir: string, options: SkillStoreOptions = {}): SkillRecord[] {
  if (kindOf(skillsDir) !== "dir") return [];
  migrateFlatSkills(skillsDir, options);
  const out = canonicalRecords(skillsDir);
  for (const flat of flatFiles(skillsDir)) {
    const record = readFlat(skillsDir, flat);
    if (record === null || out.has(record.name)) continue;
    out.set(record.name, record);
  }
  const usage = readSkillUsage(skillsDir);
  return [...out.values()]
    .map((record) => ({ ...record, ...(usage.get(record.name) ?? NO_USAGE) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** [D3] What a seat is told about: everything but the archived and the quarantined. */
export function listAdvertisedSkillRecords(skillsDir: string, options: SkillStoreOptions = {}): SkillRecord[] {
  return listSkillRecords(skillsDir, options).filter(isAdvertised);
}

export function findSkillRecord(skillsDir: string, name: string, options: SkillStoreOptions = {}): SkillRecord | null {
  return listSkillRecords(skillsDir, options).find((s) => s.name === name) ?? null;
}

/** [D3] The skill's bytes exactly as they sit on disk: what the ledger content-addresses. */
export function readSkillDocument(record: Pick<SkillRecord, "file">): string {
  return fs.readFileSync(record.file, "utf8");
}

/**
 * [D3] Change frontmatter metadata in place, leaving the body and every other field untouched.
 * A null value removes the key rather than writing an empty one. Returns the new document.
 */
export function updateSkillMeta(record: Pick<SkillRecord, "file">, patch: Record<string, string | null>): string {
  const { fields, body } = parseFrontmatter(readSkillDocument(record));
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete fields[key];
    else fields[key] = value;
  }
  const next = renderFrontmatter(fields, body);
  writeSkillFile(record.file, next);
  return next;
}

/** Write one skill in the canonical form. Returns the SKILL.md path. */
export function writeSkillRecord(skillsDir: string, input: SkillWriteInput): string {
  if (!SKILL_NAME_PATTERN.test(input.name)) {
    throw new Error(
      `invalid skill name "${input.name}": lowercase letters, digits, - and _, up to 64 characters`,
    );
  }
  const category = (input.category ?? DEFAULT_SKILL_CATEGORY).trim() || DEFAULT_SKILL_CATEGORY;
  const dir = skillDirFor(skillsDir, input.name, category);
  const file = path.join(dir, SKILL_FILE);
  const quarantineReason = input.quarantineReason ?? null;
  const fields: Record<string, string> = {
    name: input.title ?? input.name,
    description: input.description ?? "",
    category,
    trust: input.trust ?? MIGRATED_SKILL_TRUST,
    version: input.version ?? DEFAULT_SKILL_VERSION,
    author: input.author ?? "community",
    tags: (input.tags ?? [category]).join(", "),
    // [D3] The lifecycle travels with the skill, so a profile copied anywhere keeps its state.
    status: input.status ?? DEFAULT_SKILL_STATUS,
    created_by: input.createdBy ?? DEFAULT_SKILL_PROVENANCE,
    promoted_at: input.promotedAt ?? new Date().toISOString(),
    ...(quarantineReason === null ? {} : { quarantine_reason: quarantineReason }),
  };
  writeSkillFile(file, renderFrontmatter(fields, input.instructions));
  return file;
}

/** Atomic write into the store: owner-only file, owner-only directory. */
export function writeSkillFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: SKILL_DIR_MODE });
  atomicWriteFileSync(NODE_IO, file, content, SKILL_FILE_MODE);
}

/** Remove a skill in whichever form it is on disk, including a flat file the migration skipped. */
export function removeSkillRecord(skillsDir: string, name: string): boolean {
  let removed = false;
  const record = findSkillRecord(skillsDir, name);
  if (record?.dir) {
    fs.rmSync(record.dir, { recursive: true, force: true });
    removed = true;
  }
  for (const ext of [".md", ".json"]) {
    const flat = path.join(skillsDir, `${name}${ext}`);
    if (kindOf(flat) === "file") {
      fs.unlinkSync(flat);
      removed = true;
    }
  }
  // Counters outlive nothing: a reinstall of the same slug starts from no usage at all.
  if (removed) forgetSkillUsage(skillsDir, name);
  return removed;
}
