/**
 * Skill usage telemetry: the sidecar that drives staleness.
 *
 * `use_count` and `last_used_at` live NEXT TO the skills rather than inside `SKILL.md` for one
 * reason: the curator's ledger is content-addressed over the skill's bytes, and a counter bumped
 * on every load would change those bytes on every load, so every blob would be unique and a
 * before/after diff would be noise. The document stays the document; the counters move.
 *
 * One JSON file, `<skills>/.usage.json`, owner-only, written atomically. A dot name keeps it out
 * of the store's own listing (`skill-store.ts` skips dot entries). A missing or unreadable file
 * means "nothing has been used yet", never an error: telemetry may not break a skill load.
 */
import fs from "node:fs";
import path from "node:path";

import { NODE_IO, atomicWriteFileSync } from "../config/atomic-fs.js";
import { SKILL_DIR_MODE, SKILL_FILE_MODE } from "./skill-store.js";

export const USAGE_FILE = ".usage.json";

export interface SkillUsage {
  useCount: number;
  lastUsedAt: string | null;
}

export const NO_USAGE: SkillUsage = { useCount: 0, lastUsedAt: null };

interface UsageFile {
  [slug: string]: { use_count?: number; last_used_at?: string };
}

export function usagePath(skillsDir: string): string {
  return path.join(skillsDir, USAGE_FILE);
}

/** Every slug's counters. An absent, empty or corrupt file reads as no usage at all. */
export function readSkillUsage(skillsDir: string): Map<string, SkillUsage> {
  const out = new Map<string, SkillUsage>();
  let raw: UsageFile;
  try {
    raw = JSON.parse(fs.readFileSync(usagePath(skillsDir), "utf8")) as UsageFile;
  } catch {
    return out;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [slug, entry] of Object.entries(raw)) {
    if (entry === null || typeof entry !== "object") continue;
    const count = typeof entry.use_count === "number" && Number.isFinite(entry.use_count) ? Math.trunc(entry.use_count) : 0;
    const last = typeof entry.last_used_at === "string" && entry.last_used_at.length > 0 ? entry.last_used_at : null;
    out.set(slug, { useCount: count, lastUsedAt: last });
  }
  return out;
}

export function usageFor(skillsDir: string, slug: string): SkillUsage {
  return readSkillUsage(skillsDir).get(slug) ?? NO_USAGE;
}

/**
 * One load of one skill by a seat's run. Read-modify-write of the whole sidecar, which is what
 * keeps it a single atomic replace; the file holds one small entry per installed skill.
 */
export function recordSkillUse(skillsDir: string, slug: string, at = new Date().toISOString()): SkillUsage {
  const all = readSkillUsage(skillsDir);
  const prior = all.get(slug) ?? NO_USAGE;
  const next: SkillUsage = { useCount: prior.useCount + 1, lastUsedAt: at };
  all.set(slug, next);
  const serialised: UsageFile = {};
  for (const [name, usage] of [...all.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    serialised[name] = { use_count: usage.useCount, ...(usage.lastUsedAt === null ? {} : { last_used_at: usage.lastUsedAt }) };
  }
  fs.mkdirSync(skillsDir, { recursive: true, mode: SKILL_DIR_MODE });
  atomicWriteFileSync(NODE_IO, usagePath(skillsDir), `${JSON.stringify(serialised, null, 2)}\n`, SKILL_FILE_MODE);
  return next;
}

/** Drop one slug's counters. Called when a skill leaves the store, so a reinstall starts clean. */
export function forgetSkillUsage(skillsDir: string, slug: string): void {
  const all = readSkillUsage(skillsDir);
  if (!all.delete(slug)) return;
  const serialised: UsageFile = {};
  for (const [name, usage] of [...all.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    serialised[name] = { use_count: usage.useCount, ...(usage.lastUsedAt === null ? {} : { last_used_at: usage.lastUsedAt }) };
  }
  atomicWriteFileSync(NODE_IO, usagePath(skillsDir), `${JSON.stringify(serialised, null, 2)}\n`, SKILL_FILE_MODE);
}
