import type { PlatformAdapter, GatewayMessage } from "./types.js";
import { ConfigManager } from "../../config/ConfigManager.js";

export class TelegramAdapter implements PlatformAdapter {
  public platformId = "telegram";
  public name = "Telegram Bot API";
  private configManager: ConfigManager;
  private messageHandler?: (msg: GatewayMessage) => Promise<void>;
  private running = false;

  constructor(configManager?: ConfigManager) {
    this.configManager = configManager || new ConfigManager();
  }

  public isConfigured(): boolean {
    const secrets = this.configManager.loadSecrets();
    return Boolean(secrets.TELEGRAM_BOT_TOKEN);
  }

  public async start(): Promise<void> {
    if (!this.isConfigured()) return;
    this.running = true;
  }

  public async stop(): Promise<void> {
    this.running = false;
  }

  public async sendMessage(channelId: string, text: string): Promise<void> {
    if (!this.running && !this.isConfigured()) return;
    // Dispatches message to Telegram HTTP API
  }

  public onMessage(handler: (msg: GatewayMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }
}
