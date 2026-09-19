/**
 * The `skills` toolset's view of the one skill store (`../../skills/skill-store.ts`).
 *
 * There is a single layout on disk — `<skills>/[<category>/]<name>/SKILL.md` with its
 * `references/ scripts/ assets/` bundle — and the flat `<slug>.md|.json` form an older CLI wrote
 * is migrated into it on the first read, by the same code the CLI reads through. What remains
 * here is the part that only the tool surface needs: bundle listing, and the realpath confinement
 * that keeps every path a seat names inside that skill's own bundle directories.
 */
import fs from "node:fs";
import path from "node:path";
import {
  BUNDLE_DIRS,
  SKILL_FILE,
  SKILL_NAME_PATTERN,
  SKILL_TRUST_TIERS,
  findSkillRecord,
  isAdvertised,
  isMutable,
  listSkillRecords,
  parseFrontmatter,
  removeSkillRecord,
  renderFrontmatter,
  skillDirFor,
  writeSkillFile,
  writeSkillRecord,
  type SkillRecord,
  type SkillTrust,
} from "../../skills/skill-store.js";

export {
  BUNDLE_DIRS,
  SKILL_FILE,
  SKILL_NAME_PATTERN,
  SKILL_TRUST_TIERS,
  isAdvertised,
  isMutable,
  parseFrontmatter,
  removeSkillRecord,
  renderFrontmatter,
  skillDirFor,
  writeSkillRecord,
};
export type { SkillTrust };

/** One skill as the toolset sees it. The store's record, unchanged. */
export type SkillEntry = SkillRecord;

/** Every skill in the store, flat leftovers migrated on the way. */
export function listSkills(skillsDir: string): SkillEntry[] {
  return listSkillRecords(skillsDir);
}

export function findSkill(skillsDir: string, name: string): SkillEntry | null {
  return findSkillRecord(skillsDir, name);
}

/** Body of SKILL.md without frontmatter, or the flat file's instructions. */
export function readBody(entry: SkillEntry): string {
  return entry.instructions;
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

/** Owner-only atomic write, the same one the store uses for SKILL.md. */
export function writeAtomic(file: string, content: string): void {
  writeSkillFile(file, content);
}
