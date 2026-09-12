/**
 * Skill materialisation for agent installs.
 *
 * Installing a specialist has to put that specialist's skills on disk, and every byte written
 * has to pass `SecurityScan` first. The two-phase `plan` / `commit` split exists so that a
 * refused install writes nothing at all: the scan runs over the whole set before the first file
 * is created, so an agent with one poisoned skill cannot leave the other fourteen behind.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SecurityScan } from "../skills/SecurityScan.js";
import { TrentError, EXIT } from "../errors/index.js";

/** Where skill bodies come from. Injectable so tests can supply hostile content. */
export interface SkillSource {
  /** Full instruction text for a slug, or null when the source does not carry it. */
  read(slug: string): string | null;
}

export interface SkillWrite {
  slug: string;
  file: string;
  content: string;
}

export interface SkillPlan {
  /** Slugs whose files have to be created. */
  writes: SkillWrite[];
  /** Slugs already materialised — reinstalling must not rewrite them. */
  present: string[];
  /** Slugs the source does not carry. Recorded, never fatal. */
  unresolved: string[];
}

/** A slug must be a single path segment; anything else is a traversal attempt. */
const SAFE_SLUG = /^[a-z0-9][a-z0-9._-]*$/i;

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** `packages/trent-core/src/fleet` -> repo root. */
export const BUNDLED_SKILLS_DIR = path.resolve(
  MODULE_DIR,
  "../../../..",
  "apps/web/.agents/skills",
);

/** Reads `apps/web/.agents/skills/<slug>/SKILL.md`, the source the catalog's slugs refer to. */
export function createDirectorySkillSource(rootDir: string = BUNDLED_SKILLS_DIR): SkillSource {
  return {
    read(slug: string): string | null {
      if (!SAFE_SLUG.test(slug)) return null;
      const file = path.join(rootDir, slug, "SKILL.md");
      if (!fs.existsSync(file)) return null;
      try {
        return fs.readFileSync(file, "utf8");
      } catch {
        return null;
      }
    },
  };
}

export class SkillProvisioner {
  private skillsDir: string;
  private source: SkillSource;

  constructor(skillsDir: string, source?: SkillSource) {
    this.skillsDir = skillsDir;
    this.source = source ?? createDirectorySkillSource();
  }

  public fileFor(slug: string): string {
    return path.join(this.skillsDir, `${slug}.md`);
  }

  /**
   * Resolve and scan every slug. Throws before anything is written when a body trips the
   * scanner; the error names the slug and the findings, never the offending content.
   */
  public plan(slugs: readonly string[], agentId: string): SkillPlan {
    const writes: SkillWrite[] = [];
    const present: string[] = [];
    const unresolved: string[] = [];
    const seen = new Set<string>();

    for (const slug of slugs) {
      if (seen.has(slug)) continue;
      seen.add(slug);

      if (!SAFE_SLUG.test(slug)) {
        unresolved.push(slug);
        continue;
      }

      const file = this.fileFor(slug);
      if (fs.existsSync(file)) {
        present.push(slug);
        continue;
      }

      const content = this.source.read(slug);
      if (content === null || content === "") {
        unresolved.push(slug);
        continue;
      }

      const scan = SecurityScan.scan(content);
      if (!scan.safe) {
        throw new TrentError({
          code: EXIT.USAGE,
          operation: "fleet.install.securityScan",
          message:
            `Security scan refused skill "${slug}" required by agent "${agentId}": ` +
            scan.findings.join("; "),
          target: agentId,
          context: { agentId, skill: slug, findings: scan.findings, score: scan.score },
        });
      }

      writes.push({ slug, file, content });
    }

    return { writes, present, unresolved };
  }

  /** Materialise a plan. Returns every slug now on disk for this agent. */
  public commit(plan: SkillPlan): string[] {
    if (!fs.existsSync(this.skillsDir)) {
      fs.mkdirSync(this.skillsDir, { recursive: true });
    }
    for (const write of plan.writes) {
      fs.writeFileSync(write.file, write.content, "utf8");
    }
    return [...plan.present, ...plan.writes.map((w) => w.slug)].sort();
  }

  /** Delete the named skill files. Missing files are not an error. */
  public remove(slugs: readonly string[]): string[] {
    const removed: string[] = [];
    for (const slug of slugs) {
      if (!SAFE_SLUG.test(slug)) continue;
      const file = this.fileFor(slug);
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
        removed.push(slug);
      }
    }
    return removed;
  }
}
