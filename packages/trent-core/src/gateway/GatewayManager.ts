import { ConfigManager } from "../config/ConfigManager.js";
import { ApprovalBridge } from "./ApprovalBridge.js";
import type { PlatformAdapter, GatewayMessage } from "./platforms/types.js";
import { TelegramAdapter } from "./platforms/telegram.js";
import {
  DiscordAdapter,
  SlackAdapter,
  WhatsAppAdapter,
  SignalAdapter,
  EmailAdapter,
  TeamsAdapter,
  HomeAssistantAdapter,
} from "./platforms/adapters.js";

export class GatewayManager {
  private configManager: ConfigManager;
  private approvalBridge: ApprovalBridge;
  private adapters: Map<string, PlatformAdapter> = new Map();
  private routes: Record<string, string> = {}; // platform -> agentId

  constructor(configManager?: ConfigManager) {
    this.configManager = configManager || new ConfigManager();
    this.approvalBridge = new ApprovalBridge();
    this.initializeAdapters();
  }

  private initializeAdapters(): void {
    const list: PlatformAdapter[] = [
      new TelegramAdapter(this.configManager),
      new DiscordAdapter(this.configManager),
      new SlackAdapter(this.configManager),
      new WhatsAppAdapter(this.configManager),
      new SignalAdapter(this.configManager),
      new EmailAdapter(this.configManager),
      new TeamsAdapter(this.configManager),
      new HomeAssistantAdapter(this.configManager),
    ];

    for (const adapter of list) {
      this.adapters.set(adapter.platformId, adapter);
    }

    const config = this.configManager.loadConfig();
    this.routes = config.gateway?.routes || {
      telegram: "support",
      slack: "ceo",
      discord: "eng-ai-engineer",
    };
  }

  public getApprovalBridge(): ApprovalBridge {
    return this.approvalBridge;
  }

  public getAdapter(platformId: string): PlatformAdapter | undefined {
    return this.adapters.get(platformId);
  }

  public getAgentForPlatform(platformId: string): string {
    return this.routes[platformId] || "ceo";
  }

  public setRoute(platformId: string, agentId: string): void {
    this.routes[platformId] = agentId;
    const config = this.configManager.loadConfig();
    if (!config.gateway) config.gateway = { enabled: true, platforms: [], routes: {} };
    config.gateway.routes = this.routes;
    this.configManager.saveConfig(config);
  }

  public getStatus(): Record<
    string,
    { name: string; configured: boolean; designatedAgent: string }
  > {
    const result: Record<string, { name: string; configured: boolean; designatedAgent: string }> =
      {};

    for (const [id, adapter] of this.adapters.entries()) {
      result[id] = {
        name: adapter.name,
        configured: adapter.isConfigured(),
        designatedAgent: this.getAgentForPlatform(id),
      };
    }

    return result;
  }

  public async startAllConfigured(): Promise<string[]> {
    const started: string[] = [];
    for (const [id, adapter] of this.adapters.entries()) {
      if (adapter.isConfigured()) {
        await adapter.start();
        started.push(id);
      }
    }
    return started;
  }

  public async stopAll(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      await adapter.stop();
    }
  }
}
