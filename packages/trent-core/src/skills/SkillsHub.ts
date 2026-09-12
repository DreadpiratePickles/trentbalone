import fs from "node:fs";
import path from "node:path";
import { ConfigManager } from "../config/ConfigManager.js";
import { SecurityScan } from "./SecurityScan.js";
import { SkillLoader, type SkillMetadata, type LoadedSkill } from "./SkillLoader.js";

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

    // 2. Save skill file
    const skillPath = path.join(skillsDir, `${slug}.md`);
    fs.writeFileSync(skillPath, content, "utf8");

    return this.loader.loadFull(slug);
  }

  public remove(slug: string): boolean {
    const skillsDir = this.configManager.getSkillsDir();
    const mdPath = path.join(skillsDir, `${slug}.md`);
    const jsonPath = path.join(skillsDir, `${slug}.json`);

    let removed = false;
    if (fs.existsSync(mdPath)) {
      fs.unlinkSync(mdPath);
      removed = true;
    }
    if (fs.existsSync(jsonPath)) {
      fs.unlinkSync(jsonPath);
      removed = true;
    }
    return removed;
  }
}
