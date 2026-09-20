import fs from "node:fs";
import { ConfigManager } from "../config/ConfigManager.js";
import { createLayeredSkillSource, listSourceSkills } from "../fleet/SkillProvisioner.js";
import { SecurityScan } from "./SecurityScan.js";
import { SkillLoader, type SkillMetadata, type LoadedSkill } from "./SkillLoader.js";
import {
  DEFAULT_SKILL_CATEGORY,
  MIGRATED_SKILL_TRUST,
  SKILL_TRUST_TIERS,
  parseFrontmatter,
  removeSkillRecord,
  writeSkillRecord,
  type SkillTrust,
} from "./skill-store.js";

export interface SkillCatalogItem {
  slug: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  sampleInstructions: string;
}

export const BUILTIN_SKILLS_CATALOG: SkillCatalogItem[] = [
  {
    slug: "repo-audit",
    name: "Repository Architecture Audit",
    description: "Deep codebase mapping, architectural dependency graph, and security hotspots check.",
    category: "engineering",
    tags: ["audit", "code", "architecture"],
    sampleInstructions: "# Repository Audit\nAnalyze package dependencies, circular imports, and API surface.",
  },
  {
    slug: "competitive-teardown",
    name: "Competitive Teardown",
    description: "Evaluates competitor positioning, feature sets, pricing models, and defensive moats.",
    category: "strategy",
    tags: ["market", "competitors", "research"],
    sampleInstructions: "# Competitive Teardown\nCompare feature sets, customer reviews, and market signals.",
  },
  {
    slug: "pr-reviewer",
    name: "Autonomous PR Reviewer",
    description: "Reviews code changes against correctness, performance, test coverage, and security criteria.",
    category: "engineering",
    tags: ["github", "review", "testing"],
    sampleInstructions: "# Autonomous PR Reviewer\nReview git diffs for edge cases, null checks, and test regression.",
  },
  {
    slug: "landing-page-copy",
    name: "High-Conversion Copywriter",
    description: "Generates benefit-driven landing page headlines, feature grids, and founder notes.",
    category: "growth",
    tags: ["copywriting", "landing-page", "marketing"],
    sampleInstructions: "# Landing Page Copy\nWrite direct, hype-free copy highlighting value and proof.",
  },
  {
    slug: "financial-runway-forecast",
    name: "Financial Runway Forecast",
    description: "Calculates burn rate, runway months, cash break-even scenarios, and budget caps.",
    category: "finance",
    tags: ["finance", "runway", "cashflow"],
    sampleInstructions: "# Financial Runway Forecast\nProject revenue, variable costs, and runway trajectories.",
  },
  {
    slug: "customer-escalation-triage",
    name: "Support Escalation Triage",
    description: "Classifies ticket urgency, synthesizes repro steps, and drafts polite empathetic replies.",
    category: "support",
    tags: ["support", "tickets", "triage"],
    sampleInstructions: "# Support Escalation Triage\nDiagnose root issue, isolate user frustration, provide fix steps.",
  },
];

export class SkillsHub {
  private configManager: ConfigManager;
  private loader: SkillLoader;

  constructor(configManager?: ConfigManager) {
    this.configManager = configManager || new ConfigManager();
    this.loader = new SkillLoader(this.configManager.getSkillsDir());
  }

  public getLoader(): SkillLoader {
    return this.loader;
  }

  public browse(): SkillCatalogItem[] {
    return BUILTIN_SKILLS_CATALOG;
  }

  /** The built-in catalog first, then every bundled skill (app source, then core) that matches. */
  public search(term: string): SkillCatalogItem[] {
    const q = term.toLowerCase();
    const matches = (s: SkillCatalogItem): boolean =>
      s.slug.includes(q) ||
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.tags.some((t) => t.toLowerCase().includes(q));
    const builtin = BUILTIN_SKILLS_CATALOG.filter(matches);
    const seen = new Set(builtin.map((s) => s.slug));
    const bundled = listSourceSkills()
      .filter((entry) => !seen.has(entry.name))
      .map((entry) => bundledCatalogItem(entry.name, entry.file))
      .filter((item): item is SkillCatalogItem => item !== null && matches(item));
    return [...builtin, ...bundled];
  }

  public listInstalled(): SkillMetadata[] {
    return this.loader.listMetadata();
  }

  /**
   * Install into the one store, in the canonical directory form, so the `skills` toolset can read,
   * view and edit what the CLI installed. The pre-install scan is unchanged and still cannot be
   * forced: nothing is written when it fails.
   */
  public install(slug: string, customInstructions?: string): LoadedSkill {
    const skillsDir = this.configManager.getSkillsDir();
    const item = BUILTIN_SKILLS_CATALOG.find((s) => s.slug === slug);
    // Neither the built-in catalog nor the caller carries it: the bundled sources, app then core,
    // are the same ones `fleet install` materialises from.
    const bundled = customInstructions || item ? null : createLayeredSkillSource().read(slug);
    const document = customInstructions || item?.sampleInstructions || bundled || `# ${slug}\nCustom skill`;
    const { fields, body: content } = bundled === null ? { fields: {}, body: document } : parseFrontmatter(document);

    // 1. Run Security Scan
    const scan = SecurityScan.scan(document);
    if (!scan.safe) {
      throw new Error(
        `Security verification failed for skill "${slug}": ${scan.findings.join("; ")}`
      );
    }

    // 2. Save the skill, metadata explicit, as a skill a person installed and the agent may edit.
    // A bundled skill keeps its own metadata, its trust tier included, so a shipped `official`
    // skill stays read-only in the profile.
    const heading = headingOf(content);
    const trust: SkillTrust = SKILL_TRUST_TIERS.includes(fields.trust as SkillTrust) ? (fields.trust as SkillTrust) : MIGRATED_SKILL_TRUST;
    const category = item?.category ?? fields.category ?? DEFAULT_SKILL_CATEGORY;
    const tags = fields.tags ? fields.tags.split(",").map((t) => t.trim()).filter((t) => t.length > 0) : [];
    writeSkillRecord(skillsDir, {
      name: slug,
      title: item?.name ?? heading ?? fields.name ?? slug,
      description: item?.description ?? fields.description ?? descriptionOf(content) ?? "",
      category,
      trust,
      ...(fields.version ? { version: fields.version } : {}),
      ...(fields.author ? { author: fields.author } : {}),
      tags: item?.tags ?? (tags.length > 0 ? tags : [category]),
      instructions: content,
      // [D3] A person ran `trent skills install`, so the skill is theirs: declared provenance,
      // which is what keeps the curator from aging it out from under them.
      createdBy: "human",
    });
    this.loader.invalidate(slug);

    // Installing is not using: the counters stay at zero and `promoted_at` is the aging baseline.
    return this.loader.loadFull(slug, { recordUse: false });
  }

  public remove(slug: string): boolean {
    const removed = removeSkillRecord(this.configManager.getSkillsDir(), slug);
    this.loader.invalidate(slug);
    return removed;
  }
}

/** A bundled SKILL.md as a catalog item, from its frontmatter; null when it cannot be read. */
function bundledCatalogItem(slug: string, file: string): SkillCatalogItem | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const { fields, body } = parseFrontmatter(text);
  const category = fields.category ?? DEFAULT_SKILL_CATEGORY;
  const tags = fields.tags ? fields.tags.split(",").map((t) => t.trim()).filter((t) => t.length > 0) : [category];
  return {
    slug,
    name: headingOf(body) ?? fields.name ?? slug,
    description: fields.description ?? descriptionOf(body) ?? "",
    category,
    tags,
    sampleInstructions: body,
  };
}

/** The first `# ` heading of a hand-supplied body, when it has one. */
function headingOf(content: string): string | undefined {
  const line = content.split("\n").find((l) => l.startsWith("# "));
  return line ? line.slice(2).trim() : undefined;
}

/** The first `> ` line of a hand-supplied body, when it has one. */
function descriptionOf(content: string): string | undefined {
  const line = content.split("\n").find((l) => l.startsWith("> "));
  return line ? line.slice(2).trim() : undefined;
}
