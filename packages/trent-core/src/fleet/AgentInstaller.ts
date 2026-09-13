import fs from "node:fs";
import path from "node:path";
import { ConfigManager } from "../config/ConfigManager.js";
import { AGENT_CATALOG, type CatalogAgent } from "../agents/index.js";
import { TrentError, EXIT } from "../errors/index.js";
import { SkillProvisioner, type SkillSource } from "./SkillProvisioner.js";

export interface InstalledAgentTool {
  name: string;
  purpose: string;
}

export interface InstalledAgentConfig {
  id: string;
  name: string;
  emoji: string;
  category: string;
  color: string;
  modelPolicy: string;
  installed_at: string;
  active: boolean;
  tools: InstalledAgentTool[];
  /** Skill slugs the agent asks for. */
  skills: string[];
  /** Skill slugs actually materialised in the profile's skills dir. */
  installed_skills: string[];
  /** Canonical per-run budget cap, INTEGER CENTS. */
  budget_cap_per_run_cents: number;
  /** @deprecated Derived dollars view for existing readers. Never accumulate into it. */
  budget_cap_per_run: number;
}

export interface CoreRole {
  name: string;
  emoji: string;
  category: string;
  color: string;
  modelPolicy: string;
  description: string;
  /** Role-level per-run cap in INTEGER CENTS. Overrides `budget.per_run_cap` when set. */
  budgetCapCents?: number;
}

/** Every core role runs with the same base toolset. */
export const CORE_ROLE_TOOLS: readonly InstalledAgentTool[] = [
  { name: "file_ops", purpose: "File system operations" },
  { name: "terminal", purpose: "Sandboxed terminal execution" },
];

// Colours come from the brand category palette (apps/cli/src/ui/theme.ts), never the v1 purple
// set. The CEO seat takes pulse, per the style contract; state colour still outranks identity.
export const CORE_ROLES: Record<string, CoreRole> = {
  ceo: {
    name: "CEO Agent",
    emoji: "👑",
    category: "executive",
    color: "#6EE7B7",
    modelPolicy: "best-reasoning",
    description: "Prioritizes strategy, roadmap, risks, and operating cycle summaries.",
    // Runs on the most expensive tier by policy, so it gets twice the default per-run cap.
    budgetCapCents: 200,
  },
  engineer: {
    name: "Lead Engineer",
    emoji: "⚡",
    category: "engineering",
    color: "#67E8F9",
    modelPolicy: "code-capable",
    description: "Plans code changes, GitHub work, tests, and technical architecture.",
  },
  growth: {
    name: "Growth Hacker",
    emoji: "📈",
    category: "marketing",
    color: "#FB923C",
    modelPolicy: "growth-generalist",
    description: "Designs acquisition experiments, campaigns, and funnel improvements.",
  },
  content: {
    name: "Design & Content Lead",
    emoji: "🎨",
    category: "design",
    color: "#F9A8D4",
    modelPolicy: "copywriter",
    description: "Creates design direction, landing copy, docs, and creative briefs.",
  },
  support: {
    name: "Support & Ops Responder",
    emoji: "💬",
    category: "support",
    color: "#C4B5FD",
    modelPolicy: "support-safe",
    description: "Drafts replies, mines customer feedback, and handles operational queues.",
  },
  analyst: {
    name: "Market & Data Analyst",
    emoji: "📊",
    category: "product",
    color: "#A5B4FC",
    modelPolicy: "analyst",
    description: "Researches markets, competitors, and revenue metrics.",
  },
  finance: {
    name: "Finance & Treasury Lead",
    emoji: "💰",
    category: "finance",
    color: "#A5F3D2",
    modelPolicy: "cost-aware",
    description: "Tracks spend, margins, budget caps, and financial runways.",
  },
  browser: {
    name: "Autonomous Web Navigator",
    emoji: "🌐",
    category: "specialized",
    color: "#7DD3FC",
    modelPolicy: "balanced",
    description: "Executes web research, scraping, and form automation.",
  },
  escalation: {
    name: "Critic & Compliance Auditor",
    emoji: "🛡️",
    category: "specialized",
    color: "#FDBA74",
    modelPolicy: "safety",
    description: "Critiques plans and audits risk before irreversible execution.",
    // A critique pass is short by design; a runaway auditor is a pure cost with no output.
    budgetCapCents: 50,
  },
};

export const CORE_ROLE_IDS: readonly string[] = Object.keys(CORE_ROLES);

/** Prefixes a bare query may be missing, in catalog order. */
const ID_PREFIXES = ["eng", "sup", "mkt", "fin", "spec", "sales", "paid", "prod", "pm"];

export interface AgentInstallerOptions {
  /** Where skill bodies come from. Defaults to the bundled `.agents/skills` tree. */
  skillSource?: SkillSource;
}

export class AgentInstaller {
  private configManager: ConfigManager;
  private provisioner: SkillProvisioner;

  constructor(configManager?: ConfigManager, options?: AgentInstallerOptions) {
    this.configManager = configManager || new ConfigManager();
    this.provisioner = new SkillProvisioner(
      this.configManager.getSkillsDir(),
      options?.skillSource,
    );
  }

  // ------------------------------------------------------------- resolution

  /**
   * Resolve a query to exactly one agent.
   *
   * Exact matches — core role id, catalog id, prefixed catalog id, catalog name — win outright.
   * Only then is a substring search attempted, and it resolves ONLY when it finds a single
   * candidate. A query matching several specialists throws rather than picking one: silently
   * installing "Search Query Analyst" because the operator typed "analyst" is a wrong install,
   * not a convenience.
   */
  public findAgent(agentId: string): InstalledAgentConfig | undefined {
    const norm = agentId.toLowerCase().trim();
    if (norm === "") return undefined;

    const core = CORE_ROLES[norm];
    if (core) return this.fromCoreRole(norm, core);

    const exact = AGENT_CATALOG.find((a) => {
      const id = a.id.toLowerCase();
      return (
        id === norm ||
        a.name.toLowerCase() === norm ||
        ID_PREFIXES.some((prefix) => id === `${prefix}-${norm}`)
      );
    });
    if (exact) return this.fromCatalog(exact);

    const candidates = AGENT_CATALOG.filter(
      (a) => a.id.toLowerCase().includes(norm) || a.name.toLowerCase().includes(norm),
    );

    if (candidates.length === 1) return this.fromCatalog(candidates[0] as CatalogAgent);

    if (candidates.length > 1) {
      const ids = candidates.map((a) => a.id);
      throw new TrentError({
        code: EXIT.USAGE,
        operation: "fleet.findAgent",
        message:
          `Agent query "${agentId}" is ambiguous: ${candidates.length} specialists match. ` +
          `Use an exact id — ${ids.slice(0, 8).join(", ")}` +
          (ids.length > 8 ? `, and ${ids.length - 8} more.` : "."),
        target: agentId,
        context: { query: norm, candidates: ids },
      });
    }

    return undefined;
  }

  private baseCapCents(): number {
    return this.configManager.loadConfig().budget.per_run_cap;
  }

  private fromCoreRole(id: string, core: CoreRole): InstalledAgentConfig {
    const cents = core.budgetCapCents ?? this.baseCapCents();
    return {
      id,
      name: core.name,
      emoji: core.emoji,
      category: core.category,
      color: core.color,
      modelPolicy: core.modelPolicy,
      installed_at: new Date().toISOString(),
      active: true,
      tools: [...CORE_ROLE_TOOLS],
      skills: [],
      installed_skills: [],
      budget_cap_per_run_cents: cents,
      budget_cap_per_run: cents / 100,
    };
  }

  private fromCatalog(found: CatalogAgent): InstalledAgentConfig {
    const cents = this.baseCapCents();
    return {
      id: found.id,
      name: found.name,
      emoji: found.emoji,
      category: found.category,
      color: found.color || "#94A3B8", // mist: the neutral for an uncategorised specialist, never the v1 purple
      modelPolicy: found.modelPolicy || "balanced",
      installed_at: new Date().toISOString(),
      active: true,
      tools: (found.designedTools || []).map((t) => ({ name: t.name, purpose: t.purpose })),
      skills: [...(found.skills || [])],
      installed_skills: [],
      budget_cap_per_run_cents: cents,
      budget_cap_per_run: cents / 100,
    };
  }

  // ---------------------------------------------------------------- install

  /**
   * Install an agent, idempotently. The skill scan runs to completion before the first write,
   * so a refused install leaves the profile exactly as it found it.
   */
  public install(agentId: string): InstalledAgentConfig {
    this.configManager.ensureDirs();

    const agent = this.findAgent(agentId);
    if (!agent) {
      throw new TrentError({
        code: EXIT.USAGE,
        operation: "fleet.install",
        message: `Agent "${agentId}" not found in core roles or the 164-agent catalog.`,
        target: agentId,
      });
    }

    const agentConfigPath = this.pathFor(agent.id);
    const existing = this.readInstalled(agent.id);
    if (existing) {
      // Reinstalling must not rewrite history.
      agent.installed_at = existing.installed_at;
    }

    // Phase 1: resolve and scan. Throws on a dangerous body, before anything is written.
    const plan = this.provisioner.plan(agent.skills, agent.id);

    // Phase 2: commit.
    agent.installed_skills = this.provisioner.commit(plan);
    fs.writeFileSync(agentConfigPath, JSON.stringify(agent, null, 2), "utf8");

    const config = this.configManager.loadConfig();
    const installed = new Set(config.fleet.installed_agents);
    const active = new Set(config.fleet.active_agents);
    installed.add(agent.id);
    active.add(agent.id);
    config.fleet.installed_agents = Array.from(installed);
    config.fleet.active_agents = Array.from(active);
    this.configManager.saveConfig(config);

    return agent;
  }

  // -------------------------------------------------------------- uninstall

  /**
   * Remove an agent's record, its exclusively-owned skill files, and its config entries.
   * Returns false when there was nothing to remove. Skills another installed agent still
   * references are left in place.
   */
  public uninstall(agentId: string): boolean {
    const norm = agentId.toLowerCase().trim();

    let resolvedId = norm;
    try {
      const agent = this.findAgent(norm);
      if (agent) resolvedId = agent.id;
    } catch {
      // An ambiguous query cannot name an installed agent; fall back to the literal id.
    }

    const config = this.configManager.loadConfig();
    const inConfig =
      config.fleet.installed_agents.some((id) => id === resolvedId || id === norm) ||
      config.fleet.active_agents.some((id) => id === resolvedId || id === norm);

    const record = this.readInstalled(resolvedId);
    if (!record && !inConfig) return false;

    if (record) {
      const stillNeeded = this.skillsNeededByOthers(resolvedId);
      this.provisioner.remove(record.installed_skills.filter((s) => !stillNeeded.has(s)));
      fs.unlinkSync(this.pathFor(resolvedId));
    }

    config.fleet.installed_agents = config.fleet.installed_agents.filter(
      (id) => id !== resolvedId && id !== norm,
    );
    config.fleet.active_agents = config.fleet.active_agents.filter(
      (id) => id !== resolvedId && id !== norm,
    );
    this.configManager.saveConfig(config);

    return true;
  }

  /** Every skill slug claimed by an installed agent other than `excludeId`. */
  private skillsNeededByOthers(excludeId: string): Set<string> {
    const needed = new Set<string>();
    const dir = this.configManager.getAgentsDir();
    if (!fs.existsSync(dir)) return needed;

    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith(".json")) continue;
      const id = entry.slice(0, -".json".length);
      if (id === excludeId) continue;
      const record = this.readInstalled(id);
      for (const slug of record?.installed_skills ?? []) needed.add(slug);
    }
    return needed;
  }

  public listInstalled(): InstalledAgentConfig[] {
    const dir = this.configManager.getAgentsDir();
    if (!fs.existsSync(dir)) return [];
    const out: InstalledAgentConfig[] = [];
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith(".json")) continue;
      const record = this.readInstalled(entry.slice(0, -".json".length));
      if (record) out.push(record);
    }
    return out;
  }

  private pathFor(id: string): string {
    return path.join(this.configManager.getAgentsDir(), `${id}.json`);
  }

  private readInstalled(id: string): InstalledAgentConfig | null {
    const file = this.pathFor(id);
    if (!fs.existsSync(file)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<InstalledAgentConfig>;
      if (typeof parsed.id !== "string") return null;
      return {
        ...(parsed as InstalledAgentConfig),
        installed_skills: Array.isArray(parsed.installed_skills) ? parsed.installed_skills : [],
      };
    } catch {
      return null;
    }
  }
}
