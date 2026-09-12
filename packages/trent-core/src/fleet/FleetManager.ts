import { ConfigManager } from "../config/ConfigManager.js";
import { AGENT_CATALOG, type CatalogAgent } from "../agents/index.js";
import { TrentError, EXIT } from "../errors/index.js";
import {
  AgentInstaller,
  CORE_ROLES,
  CORE_ROLE_TOOLS,
  type InstalledAgentConfig,
} from "./AgentInstaller.js";
import { FLEET_PACKS, resolveFleetPack } from "./FleetPacks.js";
import { FleetUsage, type RecordSpendOptions, type SpendEntry } from "./FleetUsage.js";
import type { SkillSource } from "./SkillProvisioner.js";

export type AgentStatus = "active" | "idle" | "offline";

/** A core role is a built-in cofounder seat; a specialist comes from the 164-agent catalog. */
export type FleetAgentKind = "core" | "specialist";

export interface FleetAgentSummary {
  id: string;
  name: string;
  emoji: string;
  category: string;
  kind: FleetAgentKind;
  status: AgentStatus;
  color: string;
  modelPolicy: string;
  installed: boolean;
  active: boolean;
  specialties: string;
  toolsCount: number;
}

export interface FleetStatusReport {
  /** Number of specialists in the catalog (164). */
  totalCatalog: number;
  /** Number of built-in core roles (9). */
  totalCoreRoles: number;
  installedCount: number;
  activeCount: number;
  /** Today's measured spend, INTEGER CENTS. */
  dailyBudgetSpentCents: number;
  /** Configured daily cap, INTEGER CENTS. */
  dailyBudgetCapCents: number;
  /** @deprecated Derived dollars view. Do not compute with it. */
  dailyBudgetSpent: number;
  /** @deprecated Derived dollars view. Do not compute with it. */
  dailyBudgetCap: number;
  agents: FleetAgentSummary[];
}

export interface FleetManagerOptions {
  skillSource?: SkillSource;
  usage?: FleetUsage;
}

export class FleetManager {
  private configManager: ConfigManager;
  private installer: AgentInstaller;
  private usage: FleetUsage;

  constructor(configManager?: ConfigManager, options?: FleetManagerOptions) {
    this.configManager = configManager || new ConfigManager();
    const installerOptions = options?.skillSource ? { skillSource: options.skillSource } : undefined;
    this.installer = new AgentInstaller(this.configManager, installerOptions);
    this.usage = options?.usage ?? new FleetUsage(this.configManager);
  }

  public listCatalog(): CatalogAgent[] {
    return [...AGENT_CATALOG];
  }

  public getAgent(agentId: string): CatalogAgent | undefined {
    return AGENT_CATALOG.find((a) => a.id === agentId);
  }

  /**
   * Every seat the fleet can hold: the nine core roles first, then the 164 specialists.
   * Core roles were previously absent, so an installed CEO was invisible in `getStatus()`
   * and missing from both counts.
   */
  public listAgents(): FleetAgentSummary[] {
    const config = this.configManager.loadConfig();
    const installedSet = new Set(config.fleet?.installed_agents || []);
    const activeSet = new Set(config.fleet?.active_agents || []);

    const summarize = (
      id: string,
      kind: FleetAgentKind,
      fields: Omit<FleetAgentSummary, "id" | "kind" | "installed" | "active" | "status">,
    ): FleetAgentSummary => {
      const installed = installedSet.has(id);
      const active = activeSet.has(id);
      const status: AgentStatus = active ? "active" : installed ? "idle" : "offline";
      return { id, kind, installed, active, status, ...fields };
    };

    const summaries: FleetAgentSummary[] = [];
    const seen = new Set<string>();

    for (const [id, role] of Object.entries(CORE_ROLES)) {
      seen.add(id);
      summaries.push(
        summarize(id, "core", {
          name: role.name,
          emoji: role.emoji,
          category: role.category,
          color: role.color,
          modelPolicy: role.modelPolicy,
          specialties: role.description,
          toolsCount: CORE_ROLE_TOOLS.length,
        }),
      );
    }

    for (const agent of AGENT_CATALOG) {
      if (seen.has(agent.id)) continue;
      summaries.push(
        summarize(agent.id, "specialist", {
          name: agent.name,
          emoji: agent.emoji,
          category: agent.category,
          color: agent.color || "#8B5CF6",
          modelPolicy: agent.modelPolicy || "balanced",
          specialties: agent.specialties,
          toolsCount: (agent.designedTools || []).length,
        }),
      );
    }

    return summaries;
  }

  public install(agentId: string): InstalledAgentConfig {
    return this.installer.install(agentId);
  }

  /**
   * Install every agent a pack advertises. A pack that cannot install all of them throws with
   * the failures named — a partial install reported as success is how "Full 164-Specialist
   * Fleet" came to mean nine agents.
   */
  public installPack(packId: string): InstalledAgentConfig[] {
    const pack = resolveFleetPack(packId);
    if (!pack) {
      throw new TrentError({
        code: EXIT.USAGE,
        operation: "fleet.installPack",
        message: `Pack "${packId}" not found. Available packs: ${Object.keys(FLEET_PACKS).join(", ")}`,
        target: packId,
        context: { available: Object.keys(FLEET_PACKS) },
      });
    }

    const results: InstalledAgentConfig[] = [];
    const failures: Array<{ agentId: string; reason: string }> = [];

    for (const agentId of pack.agents) {
      try {
        results.push(this.installer.install(agentId));
      } catch (err) {
        failures.push({ agentId, reason: err instanceof Error ? err.message : String(err) });
      }
    }

    if (failures.length > 0) {
      throw new TrentError({
        code: EXIT.USAGE,
        operation: "fleet.installPack",
        message:
          `Pack "${pack.id}" advertises ${pack.agents.length} agents but ${failures.length} ` +
          `failed to install: ${failures.map((f) => f.agentId).join(", ")}`,
        target: pack.id,
        context: { installed: results.length, failures },
      });
    }

    return results;
  }

  public deploy(agentId: string): boolean {
    const config = this.configManager.loadConfig();
    if (!config.fleet.installed_agents.includes(agentId)) {
      this.installer.install(agentId);
    }

    const fresh = this.configManager.loadConfig();
    const active = new Set(fresh.fleet.active_agents);
    active.add(agentId);
    fresh.fleet.active_agents = Array.from(active);
    this.configManager.saveConfig(fresh);
    return true;
  }

  public activateAgent(agentId: string): boolean {
    return this.deploy(agentId);
  }

  public undeploy(agentId: string): boolean {
    const config = this.configManager.loadConfig();
    config.fleet.active_agents = config.fleet.active_agents.filter((id) => id !== agentId);
    this.configManager.saveConfig(config);
    return true;
  }

  public deactivateAgent(agentId: string): boolean {
    return this.undeploy(agentId);
  }

  /** Uninstall. False when the agent was not installed. */
  public remove(agentId: string): boolean {
    return this.installer.uninstall(agentId);
  }

  // ------------------------------------------------------------------ spend

  /** Record spend against an agent, in INTEGER CENTS. */
  public recordSpend(agentId: string, cents: number, options?: RecordSpendOptions): SpendEntry {
    return this.usage.record(agentId, cents, options);
  }

  public getUsage(): FleetUsage {
    return this.usage;
  }

  public getStatus(): FleetStatusReport {
    const agents = this.listAgents();
    const config = this.configManager.loadConfig();
    const spentCents = this.usage.spentTodayCents();
    const capCents = config.budget.daily_cap;

    return {
      totalCatalog: AGENT_CATALOG.length,
      totalCoreRoles: Object.keys(CORE_ROLES).length,
      installedCount: agents.filter((a) => a.installed).length,
      activeCount: agents.filter((a) => a.active).length,
      dailyBudgetSpentCents: spentCents,
      dailyBudgetCapCents: capCents,
      dailyBudgetSpent: spentCents / 100,
      dailyBudgetCap: capCents / 100,
      agents,
    };
  }
}
