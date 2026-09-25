/**
 * The transport contract every messaging adapter implements.
 *
 * An adapter is a thin, pinned client for one platform's wire protocol. It knows nothing
 * about agents, pairing, approvals or queues; those live in the gateway core and are the
 * same for all platforms. Adding platform #9 means one adapter file plus one registry entry.
 */

import type { ConfigManager } from "../../config/ConfigManager.js";
import type { GatewayStore } from "../store/GatewayStore.js";

export const CAPABILITY_KEYS = [
  "text",
  "images",
  "files",
  "threads",
  "reactions",
  "buttons",
  "typing",
] as const;
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];
export type Capabilities = Record<CapabilityKey, boolean>;

export type Scope = "dm" | "group";

/**
 * [P2-3] A file that arrived with an inbound message. Only audio is carried (voice notes and audio
 * files), for `gateway/voice-notes.ts`. An adapter never downloads in its dispatch, which runs
 * before the pairing gate: it declares what the platform said about the file and sets `open`, and
 * the gateway calls `open` only for a paired sender, reading at most `gateway.voice_notes.max_bytes`.
 */
export interface InboundAttachment {
  kind: "audio";
  /** The MIME type the platform declared, e.g. `audio/ogg`; parameters may follow a `;`. */
  mime: string;
  /** Length the platform declared, in seconds, known before any download. */
  durationSeconds?: number;
  /** Size the platform declared, in bytes, known before any download. */
  sizeBytes?: number;
  /** Set by the gateway once the bytes are on disk: `<profile>/inbox/<platform>/<message-id>.<ext>`. */
  path?: string;
  /** Bytes a platform delivered inline, when there is nothing to download. */
  bytes?: Uint8Array;
  /** Starts the download through the adapter's own HTTP client, with its auth, on its pinned host. */
  open?: () => Promise<Response>;
}

export interface InboundMessage {
  id: string;
  platform: string;
  channelId: string;
  senderId: string;
  senderName?: string;
  content: string;
  timestamp: string;
  scope: Scope;
  threadId?: string;
  metadata?: Record<string, unknown>;
  /** [P2-3] Audio that came with the message; see {@link InboundAttachment}. */
  attachments?: InboundAttachment[];
}

export interface OutboundButton {
  /** Opaque action id carried back verbatim in the callback, e.g. `trent:approve:<id>:<nonce>`. */
  id: string;
  label: string;
  style?: "primary" | "danger" | "default";
}

export interface OutboundAttachment {
  filename: string;
  contentType: string;
  /** Raw bytes, or an https URL the platform can fetch. */
  data: Uint8Array | string;
}

export interface OutboundMessage {
  channelId: string;
  text: string;
  threadId?: string;
  /** Rows of buttons. Adapters without the `buttons` capability append a text fallback. */
  buttons?: OutboundButton[][];
  attachments?: OutboundAttachment[];
  metadata?: Record<string, unknown>;
}

export interface SendReceipt {
  platform: string;
  messageId: string;
}

export type HealthState = "up" | "degraded" | "down" | "stopped";

export interface HealthStatus {
  platform: string;
  state: HealthState;
  checkedAt: string;
  latencyMs?: number;
  detail?: string;
}

/** A button press (or an equivalent, like an email reply) arriving from the platform. */
export interface ButtonCallback {
  platform: string;
  callbackId: string;
  senderId: string;
  channelId: string;
  scope: Scope;
  /** The button's `id` exactly as we sent it. */
  actionId: string;
  raw?: unknown;
}

/**
 * An emoji added to a message we sent. `emoji` is the platform's own identifier: a Slack
 * reaction name such as `+1` or `white_check_mark`, a unicode emoji on Discord and Telegram,
 * or `<name>:<id>` for a Discord custom emoji. Reactions on an approval card decide it.
 */
export interface InboundReaction {
  platform: string;
  channelId: string;
  /** The id of the message reacted to, as returned in our `SendReceipt`. */
  messageId: string;
  emoji: string;
  senderId: string;
  scope: Scope;
}

export type InboundHandler = (message: InboundMessage) => Promise<void>;
export type CallbackHandler = (callback: ButtonCallback) => Promise<CallbackAck>;
export type ReactionHandler = (reaction: InboundReaction) => Promise<void>;

/** What the adapter should tell the platform after the callback has been resolved server-side. */
export interface CallbackAck {
  ok: boolean;
  text: string;
}

/** Minimal request shape so webhook adapters do not depend on node:http types. */
export interface WebhookRequest {
  method: string;
  url: string;
  headers: Record<string, string | undefined>;
  body: string;
}

export interface WebhookResponse {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

export interface TransportAdapter {
  readonly platformId: string;
  readonly name: string;
  /** The platform API version this client is pinned to, e.g. `v22.0` or `10`. */
  readonly apiVersion: string;

  isConfigured(): boolean;
  capabilities(): Capabilities;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(message: OutboundMessage): Promise<SendReceipt>;
  onMessage(handler: InboundHandler): void;
  onCallback(handler: CallbackHandler): void;
  /** Present on adapters whose `capabilities().reactions` is true and that receive reaction events. */
  onReaction?(handler: ReactionHandler): void;
  health(): Promise<HealthStatus>;
  /** Present on adapters that can receive over an HTTP webhook. */
  handleWebhook?(request: WebhookRequest): Promise<WebhookResponse>;
}

export interface AdapterLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

/** Everything an adapter is constructed with. Secrets are read lazily and never logged. */
export interface AdapterContext {
  config: ConfigManager;
  store: GatewayStore;
  /** Override the platform API base URL. Tests point this at a local server. */
  baseUrls?: Partial<Record<string, string>>;
  fetch?: typeof fetch;
  logger?: AdapterLogger;
  /** Extra settings read before secrets, so a test can configure without a profile on disk. */
  settings?: Record<string, string>;
}

export const SILENT_LOGGER: AdapterLogger = { info() {}, warn() {} };

/** Reads a named setting: explicit settings, then the profile secrets file, then process.env. */
export function readSetting(ctx: AdapterContext, key: string): string | undefined {
  const explicit = ctx.settings?.[key];
  if (explicit !== undefined && explicit !== "") return explicit;
  let fromProfile: unknown;
  try {
    fromProfile = (ctx.config.loadSecrets() as Record<string, unknown>)[key];
  } catch {
    fromProfile = undefined;
  }
  if (typeof fromProfile === "string" && fromProfile !== "") return fromProfile;
  const fromEnv = process.env[key];
  return fromEnv !== undefined && fromEnv !== "" ? fromEnv : undefined;
}

export function baseUrlFor(ctx: AdapterContext, platformId: string, fallback: string): string {
  return (ctx.baseUrls?.[platformId] ?? fallback).replace(/\/+$/, "");
}

/** [P2-3] How long one inbound attachment download may take, body included. */
export const INBOUND_DOWNLOAD_TIMEOUT_MS = 60_000;

/**
 * [P2-3] May an adapter fetch this attachment URL, with its credentials? Only over https on one of
 * the platform's own file hosts, or on the origin of the adapter's API base (the pinned base a
 * test or a self-hosted bridge sets). A URL anywhere else is refused before any request is made.
 */
export function isPinnedDownloadUrl(url: string, apiBase: string, hosts: readonly string[]): boolean {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  if (target.origin === new URL(apiBase).origin) return true;
  return target.protocol === "https:" && hosts.includes(target.hostname.toLowerCase());
}
