import { ConfigManager } from "../config/ConfigManager.js";
import { SecurityScan } from "./SecurityScan.js";
import { SkillLoader, type SkillMetadata, type LoadedSkill } from "./SkillLoader.js";
import {
  DEFAULT_SKILL_CATEGORY,
  MIGRATED_SKILL_TRUST,
  removeSkillRecord,
  writeSkillRecord,
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

  public search(term: string): SkillCatalogItem[] {
    const q = term.toLowerCase();
    return BUILTIN_SKILLS_CATALOG.filter(
      (s) =>
        s.slug.includes(q) ||
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.tags.some((t) => t.includes(q))
    );
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
    const content = customInstructions || item?.sampleInstructions || `# ${slug}\nCustom skill`;

    // 1. Run Security Scan
    const scan = SecurityScan.scan(content);
    if (!scan.safe) {
      throw new Error(
        `Security verification failed for skill "${slug}": ${scan.findings.join("; ")}`
      );
    }

    // 2. Save the skill, metadata explicit, as a skill a person installed and the agent may edit.
    const heading = headingOf(content);
    writeSkillRecord(skillsDir, {
      name: slug,
      title: item?.name ?? heading ?? slug,
      description: item?.description ?? descriptionOf(content) ?? "",
      category: item?.category ?? DEFAULT_SKILL_CATEGORY,
      trust: MIGRATED_SKILL_TRUST,
      tags: item?.tags ?? [item?.category ?? DEFAULT_SKILL_CATEGORY],
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
