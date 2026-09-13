/**
 * Discord: REST API v10 for outbound and the Gateway (v10 websocket) for inbound.
 * https://discord.com/developers/docs/reference  https://discord.com/developers/docs/topics/gateway
 */

import {
  baseUrlFor,
  readSetting,
  SILENT_LOGGER,
  type AdapterContext,
  type ButtonCallback,
  type CallbackHandler,
  type Capabilities,
  type HealthStatus,
  type InboundHandler,
  type InboundMessage,
  type OutboundMessage,
  type SendReceipt,
  type TransportAdapter,
} from "../transport/types.js";
import { toBlobPart, expectOk, httpRequest, nowIso, TransportError } from "../transport/http.js";

export const DISCORD_API = "https://discord.com";
export const DISCORD_API_VERSION = "v10";
/** GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT */
export const DISCORD_INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);
const USER_AGENT = "DiscordBot (https://github.com/trent-fleet/trent, 1.0.0)";
const STYLE: Record<string, number> = { primary: 1, default: 2, danger: 4 };

interface DcUser { id: string; username?: string; bot?: boolean }
interface DcMessage { id: string; channel_id: string; guild_id?: string; author: DcUser; content: string; timestamp: string }
interface DcInteraction { id: string; token: string; type: number; channel_id?: string; guild_id?: string; member?: { user: DcUser }; user?: DcUser; data?: { custom_id?: string; component_type?: number } }
interface GatewayFrame { op: number; t?: string; s?: number | null; d?: unknown }

export class DiscordAdapter implements TransportAdapter {
  readonly platformId = "discord";
  readonly name = "Discord (REST v10 + Gateway v10)";
  readonly apiVersion = DISCORD_API_VERSION;
  private readonly fetch: typeof fetch;
  private messageHandler?: InboundHandler;
  private callbackHandler?: CallbackHandler;
  private ws?: WebSocket;
  private running = false;
  private seq: number | null = null;
  private heartbeat?: ReturnType<typeof setInterval>;
  private selfId?: string;

  constructor(private readonly ctx: AdapterContext) {
    this.fetch = ctx.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private token(): string {
    const t = readSetting(this.ctx, "DISCORD_BOT_TOKEN");
    if (!t) throw new TransportError("discord: DISCORD_BOT_TOKEN is not set", "discord");
    return t;
  }

  private async rest<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    const token = this.token();
    const res = await httpRequest<T>(this.fetch, "discord", `${baseUrlFor(this.ctx, "discord", DISCORD_API)}/api/${DISCORD_API_VERSION}${path}`, {
      method, body, timeoutMs,
      headers: { authorization: `Bot ${token}`, "user-agent": USER_AGENT },
    }, [token]);
    return expectOk("discord", res, [token]);
  }

  isConfigured(): boolean {
    return readSetting(this.ctx, "DISCORD_BOT_TOKEN") !== undefined;
  }

  capabilities(): Capabilities {
    return { text: true, images: true, files: true, threads: true, reactions: true, buttons: true, typing: true };
  }

  onMessage(handler: InboundHandler): void { this.messageHandler = handler; }
  onCallback(handler: CallbackHandler): void { this.callbackHandler = handler; }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const gw = await this.rest<{ url: string }>("GET", "/gateway/bot");
    await this.connect(`${gw.url}${gw.url.includes("?") ? "&" : "?"}v=10&encoding=json`);
  }

  private async connect(url: string): Promise<void> {
    const ws = new WebSocket(url);
    this.ws = ws;
    const logger = this.ctx.logger ?? SILENT_LOGGER;
    ws.addEventListener("message", (ev) => {
      void this.onFrame(JSON.parse(String(ev.data)) as GatewayFrame).catch((err: unknown) => logger.warn("discord frame error", { error: String(err) }));
    });
    ws.addEventListener("close", () => {
      clearInterval(this.heartbeat);
      if (this.running) setTimeout(() => { void this.start().catch(() => undefined); }, 5000);
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new TransportError("discord: gateway connect failed", "discord")), { once: true });
    });
  }

  private sendFrame(frame: GatewayFrame): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }

  private async onFrame(frame: GatewayFrame): Promise<void> {
    if (typeof frame.s === "number") this.seq = frame.s;
    switch (frame.op) {
      case 10: { // HELLO
        const interval = (frame.d as { heartbeat_interval: number }).heartbeat_interval;
        clearInterval(this.heartbeat);
        this.heartbeat = setInterval(() => this.sendFrame({ op: 1, d: this.seq }), interval);
        this.sendFrame({ op: 2, d: { token: this.token(), intents: DISCORD_INTENTS, properties: { os: process.platform, browser: "trent", device: "trent" } } });
        return;
      }
      case 1: this.sendFrame({ op: 1, d: this.seq }); return;
      case 7: case 9: this.ws?.close(); return; // reconnect / invalid session -> close triggers reconnect
      case 0: await this.onDispatch(frame.t ?? "", frame.d); return;
      default: return;
    }
  }

  private async onDispatch(event: string, d: unknown): Promise<void> {
    if (event === "READY") { this.selfId = (d as { user: DcUser }).user.id; return; }
    if (event === "MESSAGE_CREATE") {
      const m = d as DcMessage;
      if (m.author.bot || m.author.id === this.selfId) return;
      const msg: InboundMessage = {
        id: m.id, platform: "discord", channelId: m.channel_id, senderId: m.author.id, senderName: m.author.username,
        content: m.content, timestamp: m.timestamp, scope: m.guild_id ? "group" : "dm",
        metadata: m.guild_id ? { guildId: m.guild_id } : undefined,
      };
      await this.messageHandler?.(msg);
      return;
    }
    if (event === "INTERACTION_CREATE") {
      const i = d as DcInteraction;
      if (i.type !== 3 || !i.data?.custom_id) return;
      const user = i.member?.user ?? i.user;
      const cb: ButtonCallback = {
        platform: "discord", callbackId: i.id, senderId: user?.id ?? "", channelId: i.channel_id ?? "",
        scope: i.guild_id ? "group" : "dm", actionId: i.data.custom_id, raw: i,
      };
      const ack = (await this.callbackHandler?.(cb)) ?? { ok: false, text: "No handler." };
      // CHANNEL_MESSAGE_WITH_SOURCE, ephemeral. Must answer within 3 s or Discord shows a failure.
      await this.rest("POST", `/interactions/${i.id}/${i.token}/callback`, { type: 4, data: { content: ack.text, flags: 64 } });
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    clearInterval(this.heartbeat);
    this.ws?.close();
    this.ws = undefined;
  }

  async send(message: OutboundMessage): Promise<SendReceipt> {
    // A Discord thread is itself a channel, so threadId simply replaces channelId.
    const channel = message.threadId ?? message.channelId;
    const payload: Record<string, unknown> = { content: message.text };
    if (message.buttons && message.buttons.length > 0) {
      payload.components = message.buttons.map((row) => ({
        type: 1,
        components: row.map((b) => ({ type: 2, style: STYLE[b.style ?? "default"] ?? 2, label: b.label, custom_id: b.id })),
      }));
    }
    const files = (message.attachments ?? []).filter((a) => typeof a.data !== "string");
    if (files.length > 0) {
      const form = new FormData();
      payload.attachments = files.map((f, i) => ({ id: i, filename: f.filename }));
      form.set("payload_json", JSON.stringify(payload));
      files.forEach((f, i) => form.set(`files[${i}]`, new Blob([toBlobPart(f.data as Uint8Array)], { type: f.contentType }), f.filename));
      const m = await this.rest<DcMessage>("POST", `/channels/${channel}/messages`, form);
      return { platform: "discord", messageId: m.id };
    }
    const urls = (message.attachments ?? []).filter((a) => typeof a.data === "string").map((a) => a.data as string);
    if (urls.length > 0) payload.content = `${message.text}\n${urls.join("\n")}`;
    const m = await this.rest<DcMessage>("POST", `/channels/${channel}/messages`, payload);
    return { platform: "discord", messageId: m.id };
  }

  async react(channelId: string, messageId: string, emoji: string): Promise<void> {
    await this.rest("PUT", `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`);
  }

  async sendTyping(channelId: string): Promise<void> {
    await this.rest("POST", `/channels/${channelId}/typing`);
  }

  async health(): Promise<HealthStatus> {
    if (!this.isConfigured()) return { platform: "discord", state: "stopped", checkedAt: nowIso(), detail: "not configured" };
    const started = Date.now();
    try {
      const me = await this.rest<DcUser>("GET", "/users/@me", undefined, 10_000);
      const socketUp = this.ws?.readyState === WebSocket.OPEN;
      return { platform: "discord", state: this.running && socketUp ? "up" : "degraded", checkedAt: nowIso(), latencyMs: Date.now() - started, detail: me.username ?? me.id };
    } catch (err) {
      return { platform: "discord", state: "down", checkedAt: nowIso(), latencyMs: Date.now() - started, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}
