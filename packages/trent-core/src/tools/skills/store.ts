/**
 * Skill storage for the `skills` toolset.
 *
 * Two layouts coexist. Flat `<skills>/<slug>.md|.json` files are what the committed SkillLoader
 * and SkillsHub read and write; they are exposed read-only here with the `builtin` tier when the
 * slug is in the hub catalog. Hermes's directory layout `<skills>/[<category>/]<name>/SKILL.md`
 * with `references/ scripts/ assets/` is what `skill_manage` creates. Every path a seat names is
 * confined by realpath to the skill's own bundle directories.
 */
import fs from "node:fs";
import path from "node:path";
import { BUILTIN_SKILLS_CATALOG } from "../../skills/SkillsHub.js";
import { SkillLoader } from "../../skills/SkillLoader.js";
import { NODE_IO, atomicWriteFileSync } from "../../config/atomic-fs.js";

export type SkillTrust = "builtin" | "official" | "trusted" | "community";
export const SKILL_TRUST_TIERS: readonly SkillTrust[] = ["builtin", "official", "trusted", "community"];
export const BUNDLE_DIRS = ["references", "scripts", "assets"] as const;
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface SkillEntry {
  name: string;
  description: string;
  category: string;
  trust: SkillTrust;
  /** Directory holding SKILL.md, or null for a flat file. */
  dir: string | null;
  /** SKILL.md or the flat file. */
  file: string;
}

export function isBuiltinSlug(slug: string): boolean {
  return BUILTIN_SKILLS_CATALOG.some((s) => s.slug === slug);
}

/** The agent may only change skills it (or a person) authored: trusted and community. */
export function isMutable(trust: SkillTrust): boolean {
  return trust === "trusted" || trust === "community";
}

interface Frontmatter {
  fields: Record<string, string>;
  body: string;
}

export function parseFrontmatter(text: string): Frontmatter {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { fields: {}, body: text };
  const fields: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { fields, body: text.slice(m[0].length) };
}

export function renderFrontmatter(fields: Record<string, string>, body: string): string {
  const head = Object.entries(fields)
    .map(([k, v]) => `${k}: ${v.replace(/\n/g, " ")}`)
    .join("\n");
  return `---\n${head}\n---\n${body}`;
}

function headingMeta(body: string, fallbackName: string): { name: string; description: string } {
  let name = fallbackName;
  let description = "";
  for (const line of body.split("\n")) {
    if (line.startsWith("# ") && name === fallbackName) name = line.slice(2).trim();
    else if (line.startsWith("> ") && !description) description = line.slice(2).trim();
  }
  return { name, description };
}

function readDirSkill(dir: string, name: string, category: string): SkillEntry | null {
  const file = path.join(dir, "SKILL.md");
  if (!fs.existsSync(file)) return null;
  const { fields, body } = parseFrontmatter(fs.readFileSync(file, "utf8"));
  const meta = headingMeta(body, name);
  const trust = SKILL_TRUST_TIERS.includes(fields.trust as SkillTrust) ? (fields.trust as SkillTrust) : "community";
  return {
    name,
    description: fields.description || meta.description,
    category: fields.category || category,
    trust,
    dir,
    file,
  };
}

/** Every skill in the store: directory skills at depth one and two, then flat files. */
export function listSkills(skillsDir: string): SkillEntry[] {
  const out = new Map<string, SkillEntry>();
  if (!fs.existsSync(skillsDir)) return [];
  for (const top of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!top.isDirectory()) continue;
    const topDir = path.join(skillsDir, top.name);
    const direct = readDirSkill(topDir, top.name, "general");
    if (direct) {
      out.set(top.name, direct);
      continue;
    }
    for (const sub of fs.readdirSync(topDir, { withFileTypes: true })) {
      if (!sub.isDirectory()) continue;
      const entry = readDirSkill(path.join(topDir, sub.name), sub.name, top.name);
      if (entry && !out.has(sub.name)) out.set(sub.name, entry);
    }
  }
  for (const meta of new SkillLoader(skillsDir).listMetadata()) {
    if (out.has(meta.slug)) continue;
    out.set(meta.slug, {
      name: meta.slug,
      description: meta.description,
      category: meta.tags[0] ?? "general",
      trust: isBuiltinSlug(meta.slug) ? "builtin" : "community",
      dir: null,
      file: meta.file,
    });
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function findSkill(skillsDir: string, name: string): SkillEntry | null {
  return listSkills(skillsDir).find((s) => s.name === name) ?? null;
}

/** Body of SKILL.md without frontmatter, or the flat file's instructions. */
export function readBody(entry: SkillEntry): string {
  if (entry.dir === null) return new SkillLoader(path.dirname(entry.file)).loadFull(entry.name).instructions;
  return parseFrontmatter(fs.readFileSync(entry.file, "utf8")).body;
}

export function listBundle(entry: SkillEntry): string[] {
  if (entry.dir === null) return [];
  const lines: string[] = [];
  for (const sub of BUNDLE_DIRS) {
    const dir = path.join(entry.dir, sub);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!f.isFile()) continue;
      const size = fs.statSync(path.join(dir, f.name)).size;
      lines.push(`${sub}/${f.name} (${size} bytes)`);
    }
  }
  return lines;
}

/**
 * Resolve `relative` inside one of the bundle dirs, or explain why not. Symlinks are resolved
 * before the containment check, so a link out of the bundle cannot be followed.
 */
export function resolveBundlePath(
  entry: SkillEntry,
  relative: string
): { ok: true; file: string } | { ok: false; reason: string; blocked: boolean } {
  if (entry.dir === null) return { ok: false, reason: "flat skills have no bundled files", blocked: false };
  const normalized = path.posix.normalize(relative.replace(/\\/g, "/"));
  const first = normalized.split("/")[0] ?? "";
  if (path.isAbsolute(relative) || normalized.startsWith("..")) {
    return { ok: false, reason: `file_path "${relative}" escapes the skill directory`, blocked: true };
  }
  if (!(BUNDLE_DIRS as readonly string[]).includes(first) || normalized === first) {
    return { ok: false, reason: `file_path must be under ${BUNDLE_DIRS.join("/, ")}/`, blocked: false };
  }
  const bundleRoot = fs.realpathSync(entry.dir);
  const target = path.resolve(entry.dir, normalized);
  // Realpath the nearest existing ancestor so a symlinked directory cannot lead out of the bundle.
  let existing = target;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  const real = fs.realpathSync(existing);
  if (real !== bundleRoot && !real.startsWith(bundleRoot + path.sep)) {
    return { ok: false, reason: `file_path "${relative}" resolves outside the skill directory`, blocked: true };
  }
  return { ok: true, file: target };
}

export function writeAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteFileSync(NODE_IO, file, content, 0o644);
}
