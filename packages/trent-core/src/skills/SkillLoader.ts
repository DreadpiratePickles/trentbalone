/**
 * The read API every other module uses to resolve a skill by slug. Its shape has not changed;
 * what changed is underneath it — one store (`skill-store.ts`) serving both the canonical
 * directory form and the flat form it migrates, so a skill the agent authored and a skill the CLI
 * installed are the same skill here.
 */
import fs from "node:fs";
import {
  findSkillRecord,
  listSkillRecords,
  type SkillProvenance,
  type SkillRecord,
  type SkillStatus,
} from "./skill-store.js";
import { recordSkillUse } from "./usage.js";

export interface SkillMetadata {
  slug: string;
  name: string;
  description: string;
  version: string;
  tags: string[];
  slashCommand: string;
  author: string;
  file: string;
  /** [D3] Lifecycle state and declared provenance, so a caller can filter without a second read. */
  status: SkillStatus;
  createdBy: SkillProvenance;
  useCount: number;
  lastUsedAt: string | null;
}

export interface LoadOptions {
  /**
   * [D3] Count this load as a use. True by default, because `loadFull` is the path a seat's run
   * takes to get a skill's instructions, and that load is exactly what staleness measures. The
   * install path passes false: writing a skill is not using it.
   */
  recordUse?: boolean;
  /** Replace `now` so a test can age a skill deterministically. */
  now?: string;
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
    status: record.status,
    createdBy: record.createdBy,
    useCount: record.useCount,
    lastUsedAt: record.lastUsedAt,
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

  /**
   * The load path. Every caller that puts a skill's instructions in front of a model comes
   * through here, so this is where the curator's usage counters are bumped: a skill nobody loads
   * is a skill that ages, and one loaded every day never does.
   */
  public loadFull(slug: string, options: LoadOptions = {}): LoadedSkill {
    const record = findSkillRecord(this.skillsDir, slug);
    if (record === null) {
      throw new Error(`Skill "${slug}" not found in ${this.skillsDir}`);
    }
    const usage =
      options.recordUse === false
        ? { useCount: record.useCount, lastUsedAt: record.lastUsedAt }
        : recordSkillUse(this.skillsDir, slug, options.now);
    const meta = { ...toMetadata(record), ...usage };
    this.cache.set(slug, meta);
    return { ...meta, instructions: record.instructions };
  }
}
