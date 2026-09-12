import fs from "node:fs";
import path from "node:path";
import { ConfigManager } from "../config/ConfigManager.js";
import { AGENT_CATALOG, type CatalogAgent } from "../../../../apps/web/lib/agent-catalog.js";

export interface InstalledAgentConfig {
  id: string;
  name: string;
  emoji: string;
  category: string;
  color: string;
  modelPolicy: string;
  installed_at: string;
  active: boolean;
  tools: Array<{ name: string; purpose: string }>;
  skills: string[];
  budget_cap_per_run: number;
}

export const CORE_ROLES: Record<
  string,
  { name: string; emoji: string; category: string; color: string; modelPolicy: string; description: string }
> = {
  ceo: {
    name: "CEO Agent",
    emoji: "👑",
    category: "executive",
    color: "#8B5CF6", // Purple
    modelPolicy: "best-reasoning",
    description: "Prioritizes strategy, roadmap, risks, and operating cycle summaries.",
  },
  engineer: {
    name: "Lead Engineer",
    emoji: "⚡",
    category: "engineering",
    color: "#06B6D4", // Cyan
    modelPolicy: "code-capable",
    description: "Plans code changes, GitHub work, tests, and technical architecture.",
  },
  growth: {
    name: "Growth Hacker",
    emoji: "📈",
    category: "marketing",
    color: "#10B981", // Green
    modelPolicy: "growth-generalist",
    description: "Designs acquisition experiments, campaigns, and funnel improvements.",
  },
  content: {
    name: "Design & Content Lead",
    emoji: "🎨",
    category: "design",
    color: "#F59E0B", // Amber
    modelPolicy: "copywriter",
    description: "Creates design direction, landing copy, docs, and creative briefs.",
  },
  support: {
    name: "Support & Ops Responder",
    emoji: "💬",
    category: "support",
    color: "#3B82F6", // Blue
    modelPolicy: "support-safe",
    description: "Drafts replies, mines customer feedback, and handles operational queues.",
  },
  analyst: {
    name: "Market & Data Analyst",
    emoji: "📊",
    category: "product",
    color: "#EC4899", // Pink
    modelPolicy: "analyst",
    description: "Researches markets, competitors, and revenue metrics.",
  },
  finance: {
    name: "Finance & Treasury Lead",
    emoji: "💰",
    category: "finance",
    color: "#EF4444", // Red
    modelPolicy: "cost-aware",
    description: "Tracks spend, margins, budget caps, and financial runways.",
  },
  browser: {
    name: "Autonomous Web Navigator",
    emoji: "🌐",
    category: "specialized",
    color: "#6366F1", // Indigo
    modelPolicy: "balanced",
    description: "Executes web research, scraping, and form automation.",
  },
  escalation: {
    name: "Critic & Compliance Auditor",
    emoji: "🛡️",
    category: "specialized",
    color: "#F97316", // Orange
    modelPolicy: "safety",
    description: "Critiques plans and audits risk before irreversible execution.",
  },
};

export class AgentInstaller {
  private configManager: ConfigManager;

  constructor(configManager?: ConfigManager) {
    this.configManager = configManager || new ConfigManager();
  }

  public findAgent(agentId: string): InstalledAgentConfig | undefined {
    const norm = agentId.toLowerCase().trim();

    // 1. Check Core Roles
    if (CORE_ROLES[norm]) {
      const core = CORE_ROLES[norm];
      return {
        id: norm,
        name: core.name,
        emoji: core.emoji,
        category: core.category,
        color: core.color,
        modelPolicy: core.modelPolicy,
        installed_at: new Date().toISOString(),
        active: true,
        tools: [
          { name: "file_ops", purpose: "File system operations" },
          { name: "terminal", purpose: "Sandboxed terminal execution" },
        ],
        skills: [],
        budget_cap_per_run: 1.0,
      };
    }

    // 2. Check 164-Agent Catalog by exact ID, prefix alias, or name match
    const found = AGENT_CATALOG.find((a) => {
      const id = a.id.toLowerCase();
      const name = a.name.toLowerCase();
      return (
        id === norm ||
        id === `eng-${norm}` ||
        id === `sup-${norm}` ||
        id === `mkt-${norm}` ||
        id === `fin-${norm}` ||
        id === `spec-${norm}` ||
        name === norm ||
        name.includes(norm)
      );
    });

    if (found) {
      return {
        id: found.id,
        name: found.name,
        emoji: found.emoji,
        category: found.category,
        color: found.color || "#8B5CF6",
        modelPolicy: found.modelPolicy || "balanced",
        installed_at: new Date().toISOString(),
        active: true,
        tools: (found.designedTools || []).map((t) => ({ name: t.name, purpose: t.purpose })),
        skills: found.skills || [],
        budget_cap_per_run: 1.0,
      };
    }

    return undefined;
  }

  public install(agentId: string): InstalledAgentConfig {
    this.configManager.ensureDirs();
    const agent = this.findAgent(agentId);
    if (!agent) {
      throw new Error(`Agent "${agentId}" not found in core roles or 164-agent catalog.`);
    }

    const agentsDir = this.configManager.getAgentsDir();
    const agentConfigPath = path.join(agentsDir, `${agent.id}.json`);

    fs.writeFileSync(agentConfigPath, JSON.stringify(agent, null, 2), "utf8");

    // Update fleet config in config.yaml
    const config = this.configManager.loadConfig();
    const installed = new Set(config.fleet?.installed_agents || []);
    const active = new Set(config.fleet?.active_agents || []);

    installed.add(agent.id);
    active.add(agent.id);

    config.fleet.installed_agents = Array.from(installed);
    config.fleet.active_agents = Array.from(active);
    this.configManager.saveConfig(config);

    return agent;
  }

  public uninstall(agentId: string): boolean {
    const norm = agentId.toLowerCase().trim();
    const agentsDir = this.configManager.getAgentsDir();

    // Check direct file or find resolved id
    const agent = this.findAgent(norm);
    const targetId = agent ? agent.id : norm;
    const agentConfigPath = path.join(agentsDir, `${targetId}.json`);

    if (fs.existsSync(agentConfigPath)) {
      fs.unlinkSync(agentConfigPath);
    }

    const config = this.configManager.loadConfig();
    config.fleet.installed_agents = (config.fleet.installed_agents || []).filter(
      (id) => id !== targetId && id !== norm
    );
    config.fleet.active_agents = (config.fleet.active_agents || []).filter(
      (id) => id !== targetId && id !== norm
    );
    this.configManager.saveConfig(config);

    return true;
  }
}
