/**
 * The read API every other module uses to resolve a skill by slug. Its shape has not changed;
 * what changed is underneath it — one store (`skill-store.ts`) serving both the canonical
 * directory form and the flat form it migrates, so a skill the agent authored and a skill the CLI
 * installed are the same skill here.
 */
import fs from "node:fs";
import { findSkillRecord, listSkillRecords, type SkillRecord } from "./skill-store.js";

export interface SkillMetadata {
  slug: string;
  name: string;
  description: string;
  version: string;
  tags: string[];
  slashCommand: string;
  author: string;
  file: string;
}

export interface LoadedSkill extends SkillMetadata {
  instructions: string;
}

function toMetadata(record: SkillRecord): SkillMetadata {
  return {
    slug: record.name,
    name: record.title,
    description: record.description,
    version: record.version,
    tags: record.tags,
    slashCommand: `/${record.name}`,
    author: record.author,
    file: record.file,
  };
}

export class SkillLoader {
  private skillsDir: string;
  private cache: Map<string, SkillMetadata> = new Map();

  constructor(skillsDir: string) {
    this.skillsDir = skillsDir;
    if (!fs.existsSync(this.skillsDir)) {
      fs.mkdirSync(this.skillsDir, { recursive: true });
    }
  }

  public listMetadata(): SkillMetadata[] {
    const result = listSkillRecords(this.skillsDir).map(toMetadata);
    for (const meta of result) this.cache.set(meta.slug, meta);
    return result;
  }

  public getMetadata(slug: string): SkillMetadata | null {
    const cached = this.cache.get(slug);
    if (cached) return cached;
    const record = findSkillRecord(this.skillsDir, slug);
    if (record === null) return null;
    const meta = toMetadata(record);
    this.cache.set(slug, meta);
    return meta;
  }

  /** Forget what was read, so a write through another surface is seen by the next read. */
  public invalidate(slug?: string): void {
    if (slug === undefined) this.cache.clear();
    else this.cache.delete(slug);
  }

  public loadFull(slug: string): LoadedSkill {
    const record = findSkillRecord(this.skillsDir, slug);
    if (record === null) {
      throw new Error(`Skill "${slug}" not found in ${this.skillsDir}`);
    }
    const meta = toMetadata(record);
    this.cache.set(slug, meta);
    return { ...meta, instructions: record.instructions };
  }
}
