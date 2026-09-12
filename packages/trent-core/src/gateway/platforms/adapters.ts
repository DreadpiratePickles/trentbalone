import type { PlatformAdapter, GatewayMessage } from "./types.js";
import { ConfigManager } from "../../config/ConfigManager.js";

export class DiscordAdapter implements PlatformAdapter {
  public platformId = "discord";
  public name = "Discord Bot";
  private configManager: ConfigManager;

  constructor(configManager?: ConfigManager) {
    this.configManager = configManager || new ConfigManager();
  }

  public isConfigured(): boolean {
    return Boolean(this.configManager.loadSecrets().DISCORD_BOT_TOKEN);
  }

  public async start(): Promise<void> {}
  public async stop(): Promise<void> {}
  public async sendMessage(_channelId: string, _text: string): Promise<void> {}
  public onMessage(_handler: (msg: GatewayMessage) => Promise<void>): void {}
}

export class SlackAdapter implements PlatformAdapter {
  public platformId = "slack";
  public name = "Slack Bolt SDK";
  private configManager: ConfigManager;

  constructor(configManager?: ConfigManager) {
    this.configManager = configManager || new ConfigManager();
  }

  public isConfigured(): boolean {
    return Boolean(this.configManager.loadSecrets().SLACK_BOT_TOKEN);
  }

  public async start(): Promise<void> {}
  public async stop(): Promise<void> {}
  public async sendMessage(_channelId: string, _text: string): Promise<void> {}
  public onMessage(_handler: (msg: GatewayMessage) => Promise<void>): void {}
}

export class WhatsAppAdapter implements PlatformAdapter {
  public platformId = "whatsapp";
  public name = "WhatsApp Business API";
  private configManager: ConfigManager;

  constructor(configManager?: ConfigManager) {
    this.configManager = configManager || new ConfigManager();
  }

  public isConfigured(): boolean {
    return Boolean(this.configManager.loadSecrets().WHATSAPP_TOKEN);
  }

  public async start(): Promise<void> {}
  public async stop(): Promise<void> {}
  public async sendMessage(_channelId: string, _text: string): Promise<void> {}
  public onMessage(_handler: (msg: GatewayMessage) => Promise<void>): void {}
}

export class SignalAdapter implements PlatformAdapter {
  public platformId = "signal";
  public name = "Signal CLI";
  private configManager: ConfigManager;

  constructor(configManager?: ConfigManager) {
    this.configManager = configManager || new ConfigManager();
  }

  public isConfigured(): boolean {
    return Boolean(this.configManager.loadSecrets().SIGNAL_NUMBER);
  }

  public async start(): Promise<void> {}
  public async stop(): Promise<void> {}
  public async sendMessage(_channelId: string, _text: string): Promise<void> {}
  public onMessage(_handler: (msg: GatewayMessage) => Promise<void>): void {}
}

export class EmailAdapter implements PlatformAdapter {
  public platformId = "email";
  public name = "Email IMAP/SMTP Gateway";
  private configManager: ConfigManager;

  constructor(configManager?: ConfigManager) {
    this.configManager = configManager || new ConfigManager();
  }

  public isConfigured(): boolean {
    const secrets = this.configManager.loadSecrets();
    return Boolean(secrets.EMAIL_SMTP_HOST && secrets.EMAIL_SMTP_USER);
  }

  public async start(): Promise<void> {}
  public async stop(): Promise<void> {}
  public async sendMessage(_channelId: string, _text: string): Promise<void> {}
  public onMessage(_handler: (msg: GatewayMessage) => Promise<void>): void {}
}

export class TeamsAdapter implements PlatformAdapter {
  public platformId = "teams";
  public name = "Microsoft Teams Graph API";
  private configManager: ConfigManager;

  constructor(configManager?: ConfigManager) {
    this.configManager = configManager || new ConfigManager();
  }

  public isConfigured(): boolean {
    return Boolean(this.configManager.loadSecrets().TEAMS_CLIENT_ID);
  }

  public async start(): Promise<void> {}
  public async stop(): Promise<void> {}
  public async sendMessage(_channelId: string, _text: string): Promise<void> {}
  public onMessage(_handler: (msg: GatewayMessage) => Promise<void>): void {}
}

export class HomeAssistantAdapter implements PlatformAdapter {
  public platformId = "homeassistant";
  public name = "Home Assistant Webhook";
  private configManager: ConfigManager;

  constructor(configManager?: ConfigManager) {
    this.configManager = configManager || new ConfigManager();
  }

  public isConfigured(): boolean {
    return true; // Webhook triggers can be local
  }

  public async start(): Promise<void> {}
  public async stop(): Promise<void> {}
  public async sendMessage(_channelId: string, _text: string): Promise<void> {}
  public onMessage(_handler: (msg: GatewayMessage) => Promise<void>): void {}
}
