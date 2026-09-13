/**
 * The platform registry. Adding platform #9 is one adapter file plus one entry here;
 * `registry.test.ts` then proves the new adapter honours the full transport contract.
 */

import type { AdapterContext, Capabilities, TransportAdapter } from "./transport/types.js";
import { TelegramAdapter } from "./platforms/telegram.js";
import { DiscordAdapter } from "./platforms/discord.js";
import { SlackAdapter } from "./platforms/slack.js";
import { WhatsAppAdapter } from "./platforms/whatsapp.js";
import { SignalAdapter } from "./platforms/signal.js";
import { EmailAdapter } from "./platforms/email.js";
import { TeamsAdapter } from "./platforms/teams.js";
import { HomeAssistantAdapter } from "./platforms/homeassistant.js";

export interface PlatformEntry {
  id: string;
  name: string;
  create: (ctx: AdapterContext) => TransportAdapter;
  /** Env / secrets keys that must be present for `isConfigured()` to be true. */
  requiredSecrets: string[];
  /** Optional keys that unlock extra modes (webhooks, socket mode, polling targets). */
  optionalSecrets: string[];
  /** Env var that enables the platform's `*.live.test.ts`. */
  liveTestEnv: string;
  docsUrl: string;
}

export const PLATFORM_REGISTRY: Record<string, PlatformEntry> = {
  telegram: {
    id: "telegram", name: "Telegram", create: (ctx) => new TelegramAdapter(ctx),
    requiredSecrets: ["TELEGRAM_BOT_TOKEN"], optionalSecrets: ["TELEGRAM_WEBHOOK_URL", "TELEGRAM_WEBHOOK_SECRET"],
    liveTestEnv: "TELEGRAM_BOT_TOKEN", docsUrl: "https://core.telegram.org/bots/api",
  },
  discord: {
    id: "discord", name: "Discord", create: (ctx) => new DiscordAdapter(ctx),
    requiredSecrets: ["DISCORD_BOT_TOKEN"], optionalSecrets: [],
    liveTestEnv: "DISCORD_BOT_TOKEN", docsUrl: "https://discord.com/developers/docs/reference",
  },
  slack: {
    id: "slack", name: "Slack", create: (ctx) => new SlackAdapter(ctx),
    requiredSecrets: ["SLACK_BOT_TOKEN"], optionalSecrets: ["SLACK_APP_TOKEN", "SLACK_SIGNING_SECRET"],
    liveTestEnv: "SLACK_BOT_TOKEN", docsUrl: "https://api.slack.com/apis/socket-mode",
  },
  whatsapp: {
    id: "whatsapp", name: "WhatsApp", create: (ctx) => new WhatsAppAdapter(ctx),
    requiredSecrets: ["WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID"], optionalSecrets: ["WHATSAPP_VERIFY_TOKEN", "WHATSAPP_APP_SECRET"],
    liveTestEnv: "WHATSAPP_TOKEN", docsUrl: "https://developers.facebook.com/docs/whatsapp/cloud-api",
  },
  signal: {
    id: "signal", name: "Signal", create: (ctx) => new SignalAdapter(ctx),
    requiredSecrets: ["SIGNAL_NUMBER"], optionalSecrets: ["SIGNAL_CLI_URL"],
    liveTestEnv: "SIGNAL_NUMBER", docsUrl: "https://github.com/AsamK/signal-cli/blob/master/man/signal-cli-jsonrpc.5.adoc",
  },
  email: {
    id: "email", name: "Email", create: (ctx) => new EmailAdapter(ctx),
    requiredSecrets: ["EMAIL_SMTP_HOST", "EMAIL_SMTP_USER"],
    optionalSecrets: ["EMAIL_SMTP_PORT", "EMAIL_SMTP_PASS", "EMAIL_SMTP_SECURITY", "EMAIL_IMAP_HOST", "EMAIL_IMAP_PORT", "EMAIL_IMAP_USER", "EMAIL_IMAP_PASS", "EMAIL_IMAP_SECURITY", "EMAIL_IMAP_MAILBOX", "EMAIL_FROM", "EMAIL_POLL_INTERVAL_MS"],
    liveTestEnv: "EMAIL_SMTP_HOST", docsUrl: "https://www.rfc-editor.org/rfc/rfc5321",
  },
  teams: {
    id: "teams", name: "Microsoft Teams", create: (ctx) => new TeamsAdapter(ctx),
    requiredSecrets: ["TEAMS_TENANT_ID", "TEAMS_CLIENT_ID", "TEAMS_CLIENT_SECRET"], optionalSecrets: ["TEAMS_CHAT_IDS", "TEAMS_POLL_INTERVAL_MS", "TEAMS_WEBHOOK_CLIENT_STATE"],
    liveTestEnv: "TEAMS_CLIENT_SECRET", docsUrl: "https://learn.microsoft.com/graph/api/resources/chatmessage",
  },
  homeassistant: {
    id: "homeassistant", name: "Home Assistant", create: (ctx) => new HomeAssistantAdapter(ctx),
    requiredSecrets: ["HASS_URL", "HASS_TOKEN"], optionalSecrets: ["HASS_WEBHOOK_SECRET"],
    liveTestEnv: "HASS_TOKEN", docsUrl: "https://developers.home-assistant.io/docs/api/rest/",
  },
};

export function listPlatformIds(): string[] {
  return Object.keys(PLATFORM_REGISTRY);
}

export function createAdapter(id: string, ctx: AdapterContext): TransportAdapter {
  const entry = PLATFORM_REGISTRY[id];
  if (!entry) throw new Error(`Unknown messaging platform "${id}". Known: ${listPlatformIds().join(", ")}`);
  return entry.create(ctx);
}

export function createAllAdapters(ctx: AdapterContext): Map<string, TransportAdapter> {
  return new Map(listPlatformIds().map((id) => [id, createAdapter(id, ctx)]));
}

/** The per-platform capability matrix, the way Hermes publishes theirs. */
export function capabilityMatrix(ctx?: AdapterContext): Record<string, Capabilities> {
  const context = ctx ?? { config: undefined as never, store: undefined as never };
  const out: Record<string, Capabilities> = {};
  for (const id of listPlatformIds()) out[id] = createAdapter(id, context).capabilities();
  return out;
}
