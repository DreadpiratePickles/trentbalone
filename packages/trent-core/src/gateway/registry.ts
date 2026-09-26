/**
 * The platform registry. Adding a platform is one adapter file plus one entry here;
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
// [H4] the four clean-API platforms of wave H4 (gap 5 of the 2026-09-26 landscape).
import { MatrixAdapter } from "./platforms/matrix.js";
import { MattermostAdapter } from "./platforms/mattermost.js";
import { LineAdapter } from "./platforms/line.js";
import { NtfyAdapter } from "./platforms/ntfy.js";

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
  // [P3] the listener and `gateway setup`
  /** The name `gateway setup <platform> --token` writes; absent where no single token exists (Signal). */
  tokenSecret?: string;
  /** True when, with these settings, inbound arrives only at `/webhooks/<id>`, so `gateway start` must listen. */
  webhookOnly?: (setting: (key: string) => string | undefined) => boolean;
}

export const PLATFORM_REGISTRY: Record<string, PlatformEntry> = {
  telegram: {
    id: "telegram", name: "Telegram", create: (ctx) => new TelegramAdapter(ctx),
    requiredSecrets: ["TELEGRAM_BOT_TOKEN"], optionalSecrets: ["TELEGRAM_WEBHOOK_URL", "TELEGRAM_WEBHOOK_SECRET"],
    liveTestEnv: "TELEGRAM_BOT_TOKEN", docsUrl: "https://core.telegram.org/bots/api",
    tokenSecret: "TELEGRAM_BOT_TOKEN", webhookOnly: (setting) => setting("TELEGRAM_WEBHOOK_URL") !== undefined, // [P3]
  },
  discord: {
    id: "discord", name: "Discord", create: (ctx) => new DiscordAdapter(ctx),
    requiredSecrets: ["DISCORD_BOT_TOKEN"], optionalSecrets: [],
    liveTestEnv: "DISCORD_BOT_TOKEN", docsUrl: "https://discord.com/developers/docs/reference",
    tokenSecret: "DISCORD_BOT_TOKEN", // [P3]
  },
  slack: {
    id: "slack", name: "Slack", create: (ctx) => new SlackAdapter(ctx),
    requiredSecrets: ["SLACK_BOT_TOKEN"], optionalSecrets: ["SLACK_APP_TOKEN", "SLACK_SIGNING_SECRET"],
    liveTestEnv: "SLACK_BOT_TOKEN", docsUrl: "https://api.slack.com/apis/socket-mode",
    tokenSecret: "SLACK_BOT_TOKEN", webhookOnly: (setting) => setting("SLACK_APP_TOKEN") === undefined, // [P3] Events API mode without an app token
  },
  whatsapp: {
    id: "whatsapp", name: "WhatsApp", create: (ctx) => new WhatsAppAdapter(ctx),
    requiredSecrets: ["WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID"], optionalSecrets: ["WHATSAPP_VERIFY_TOKEN", "WHATSAPP_APP_SECRET"],
    liveTestEnv: "WHATSAPP_TOKEN", docsUrl: "https://developers.facebook.com/docs/whatsapp/cloud-api",
    tokenSecret: "WHATSAPP_TOKEN", webhookOnly: () => true, // [P3]
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
    tokenSecret: "EMAIL_SMTP_PASS", // [P3]
  },
  teams: {
    id: "teams", name: "Microsoft Teams", create: (ctx) => new TeamsAdapter(ctx),
    requiredSecrets: ["TEAMS_TENANT_ID", "TEAMS_CLIENT_ID", "TEAMS_CLIENT_SECRET"], optionalSecrets: ["TEAMS_CHAT_IDS", "TEAMS_POLL_INTERVAL_MS", "TEAMS_WEBHOOK_CLIENT_STATE"],
    liveTestEnv: "TEAMS_CLIENT_SECRET", docsUrl: "https://learn.microsoft.com/graph/api/resources/chatmessage",
    tokenSecret: "TEAMS_CLIENT_SECRET", // [P3]
  },
  homeassistant: {
    id: "homeassistant", name: "Home Assistant", create: (ctx) => new HomeAssistantAdapter(ctx),
    requiredSecrets: ["HASS_URL", "HASS_TOKEN"], optionalSecrets: ["HASS_WEBHOOK_SECRET"],
    liveTestEnv: "HASS_TOKEN", docsUrl: "https://developers.home-assistant.io/docs/api/rest/",
    tokenSecret: "HASS_TOKEN", webhookOnly: () => true, // [P3]
  },
  // [H4] Matrix, Mattermost, LINE and ntfy.
  matrix: {
    id: "matrix", name: "Matrix", create: (ctx) => new MatrixAdapter(ctx),
    requiredSecrets: ["MATRIX_HOMESERVER_URL", "MATRIX_ACCESS_TOKEN"], optionalSecrets: [],
    liveTestEnv: "MATRIX_ACCESS_TOKEN", docsUrl: "https://spec.matrix.org/v1.11/client-server-api/",
    tokenSecret: "MATRIX_ACCESS_TOKEN", // [P3]
  },
  mattermost: {
    id: "mattermost", name: "Mattermost", create: (ctx) => new MattermostAdapter(ctx),
    requiredSecrets: ["MATTERMOST_URL", "MATTERMOST_BOT_TOKEN"], optionalSecrets: [],
    liveTestEnv: "MATTERMOST_BOT_TOKEN", docsUrl: "https://api.mattermost.com/",
    tokenSecret: "MATTERMOST_BOT_TOKEN", // [P3]
  },
  line: {
    id: "line", name: "LINE", create: (ctx) => new LineAdapter(ctx),
    requiredSecrets: ["LINE_CHANNEL_ACCESS_TOKEN", "LINE_CHANNEL_SECRET"], optionalSecrets: [],
    liveTestEnv: "LINE_CHANNEL_ACCESS_TOKEN", docsUrl: "https://developers.line.biz/en/reference/messaging-api/",
    tokenSecret: "LINE_CHANNEL_ACCESS_TOKEN", webhookOnly: () => true, // [P3]
  },
  ntfy: {
    id: "ntfy", name: "ntfy", create: (ctx) => new NtfyAdapter(ctx),
    requiredSecrets: ["NTFY_TOPIC"], optionalSecrets: ["NTFY_URL", "NTFY_TOKEN", "NTFY_REPLY_TOPIC"],
    liveTestEnv: "NTFY_TOPIC", docsUrl: "https://docs.ntfy.sh/",
    tokenSecret: "NTFY_TOKEN", // [P3]
  },
  // [H4] end
};

export function listPlatformIds(): string[] {
  return Object.keys(PLATFORM_REGISTRY);
}

// [P3] the listener and `gateway setup`
/** Whether `id`'s inbound arrives only at `/webhooks/<id>` under these settings; false for an unknown id. */
export function webhookOnly(id: string, setting: (key: string) => string | undefined): boolean {
  return PLATFORM_REGISTRY[id]?.webhookOnly?.(setting) ?? false;
}

/** Every name `id` reads, required first, in registry order: what `gateway setup` may write. */
export function platformSecretNames(id: string): string[] {
  const entry = PLATFORM_REGISTRY[id];
  return entry === undefined ? [] : [...entry.requiredSecrets, ...entry.optionalSecrets];
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
