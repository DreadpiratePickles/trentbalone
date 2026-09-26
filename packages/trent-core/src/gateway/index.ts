export * from "./transport/types.js";
export * from "./transport/http.js";
export * from "./store/GatewayStore.js";
export * from "./security/PairingManager.js";
export * from "./queue/CircuitBreaker.js";
export * from "./queue/MessageQueue.js";
export * from "./registry.js";
export * from "./ApprovalBridge.js";
export * from "./RunApprovalLink.js";
export * from "./alerts.js";
export * from "./ConversationQueue.js";
export * from "./GatewayManager.js";
export * from "./WebhookServer.js";
export { TelegramAdapter } from "./platforms/telegram.js";
export { DiscordAdapter } from "./platforms/discord.js";
export { SlackAdapter } from "./platforms/slack.js";
export { WhatsAppAdapter } from "./platforms/whatsapp.js";
export { SignalAdapter } from "./platforms/signal.js";
export { EmailAdapter } from "./platforms/email.js";
export { TeamsAdapter } from "./platforms/teams.js";
export { HomeAssistantAdapter } from "./platforms/homeassistant.js";
// [H4]
export { MatrixAdapter } from "./platforms/matrix.js";
export { MattermostAdapter } from "./platforms/mattermost.js";
export { LineAdapter } from "./platforms/line.js";
export { NtfyAdapter } from "./platforms/ntfy.js";
/** Compatibility alias for the previous adapter surface. */
export type { InboundMessage as GatewayMessage } from "./transport/types.js";
