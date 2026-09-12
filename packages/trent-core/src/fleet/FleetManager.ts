import { ConfigManager } from "../config/ConfigManager.js";
import { AGENT_CATALOG, type CatalogAgent } from "../../../../apps/web/lib/agent-catalog.js";
import { AgentInstaller, type InstalledAgentConfig } from "./AgentInstaller.js";
import { FLEET_PACKS, resolveFleetPack, type FleetPack } from "./FleetPacks.js";

export type AgentStatus = "active" | "idle" | "offline";

export interface FleetAgentSummary {
  id: string;
  name: string;
  emoji: string;
  category: string;
  status: AgentStatus;
  color: string;
  modelPolicy: string;
  installed: boolean;
  active: boolean;
  specialties: string;
  toolsCount: number;
}

export interface FleetStatusReport {
  totalCatalog: number;
  installedCount: number;
  activeCount: number;
  dailyBudgetSpent: number;
  dailyBudgetCap: number;
  agents: FleetAgentSummary[];
}

export class FleetManager {
  private configManager: ConfigManager;
  private installer: AgentInstaller;

  constructor(configManager?: ConfigManager) {
    this.configManager = configManager || new ConfigManager();
    this.installer = new AgentInstaller(this.configManager);
  }

  public listCatalog(): CatalogAgent[] {
    return AGENT_CATALOG;
  }

  public getAgent(agentId: string): CatalogAgent | undefined {
    return AGENT_CATALOG.find((a) => a.id === agentId);
  }

  public listAgents(): FleetAgentSummary[] {
    const config = this.configManager.loadConfig();
    const installedSet = new Set(config.fleet?.installed_agents || []);
    const activeSet = new Set(config.fleet?.active_agents || []);

    return AGENT_CATALOG.map((agent) => {
      const isInstalled = installedSet.has(agent.id);
      const isActive = activeSet.has(agent.id);
      let status: AgentStatus = "offline";
      if (isActive) status = "active";
      else if (isInstalled) status = "idle";

      return {
        id: agent.id,
        name: agent.name,
        emoji: agent.emoji,
        category: agent.category,
        status,
        color: agent.color || "#8B5CF6",
        modelPolicy: agent.modelPolicy || "balanced",
        installed: isInstalled,
        active: isActive,
        specialties: agent.specialties,
        toolsCount: (agent.designedTools || []).length,
      };
    });
  }

  public install(agentId: string): InstalledAgentConfig {
    return this.installer.install(agentId);
  }

  public installPack(packId: string): InstalledAgentConfig[] {
    const pack = resolveFleetPack(packId);
    if (!pack) {
      throw new Error(
        `Pack "${packId}" not found. Available packs: ${Object.keys(FLEET_PACKS).join(", ")}`
      );
    }

    const results: InstalledAgentConfig[] = [];
    for (const agentId of pack.agents) {
      try {
        const installed = this.installer.install(agentId);
        results.push(installed);
      } catch {
        // Continue if single agent fails
      }
    }
    return results;
  }

  public deploy(agentId: string): boolean {
    const config = this.configManager.loadConfig();
    const installed = new Set(config.fleet?.installed_agents || []);
    if (!installed.has(agentId)) {
      this.installer.install(agentId);
    }

    const active = new Set(config.fleet?.active_agents || []);
    active.add(agentId);
    config.fleet.active_agents = Array.from(active);
    this.configManager.saveConfig(config);
    return true;
  }

  public activateAgent(agentId: string): boolean {
    return this.deploy(agentId);
  }

  public undeploy(agentId: string): boolean {
    const config = this.configManager.loadConfig();
    config.fleet.active_agents = (config.fleet.active_agents || []).filter((id) => id !== agentId);
    this.configManager.saveConfig(config);
    return true;
  }

  public deactivateAgent(agentId: string): boolean {
    return this.undeploy(agentId);
  }

  public remove(agentId: string): boolean {
    return this.installer.uninstall(agentId);
  }

  public getStatus(): FleetStatusReport {
    const agents = this.listAgents();
    const config = this.configManager.loadConfig();
    const activeCount = agents.filter((a) => a.active).length;
    const installedCount = agents.filter((a) => a.installed).length;

    return {
      totalCatalog: AGENT_CATALOG.length,
      installedCount,
      activeCount,
      dailyBudgetSpent: 0.0, // trackable via session manager
      dailyBudgetCap: config.budget?.daily_cap || 10.0,
      agents,
    };
  }
}
