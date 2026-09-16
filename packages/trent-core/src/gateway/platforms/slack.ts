/**
 * Slack: Web API for outbound (chat.postMessage, reactions.add, auth.test) and either
 * Socket Mode (apps.connections.open + websocket, needs an xapp- token) or the Events
 * API over `handleWebhook` (signed with the signing secret) for inbound.
 * https://api.slack.com/apis/socket-mode  https://api.slack.com/authentication/verifying-requests-from-slack
 */

import crypto from "node:crypto";
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
  type InboundReaction,
  type OutboundMessage,
  type ReactionHandler,
  type SendReceipt,
  type TransportAdapter,
  type WebhookRequest,
  type WebhookResponse,
} from "../transport/types.js";
import { expectOk, httpRequest, nowIso, TransportError } from "../transport/http.js";

export const SLACK_API = "https://slack.com";
export const SLACK_SIGNATURE_MAX_AGE_S = 300;

interface SlackEnvelope<T = unknown> { ok: boolean; error?: string; ts?: string; url?: string; user?: string; team?: string; data?: T }
interface SlackEvent { type: string; subtype?: string; user?: string; bot_id?: string; channel: string; channel_type?: string; text?: string; ts: string; thread_ts?: string }
/** `reaction_added`: https://api.slack.com/events/reaction_added */
interface SlackReactionEvent { type: "reaction_added"; user: string; reaction: string; item: { type: string; channel?: string; ts?: string } }
interface BlockActions { type: "block_actions"; user: { id: string }; channel?: { id: string }; actions: Array<{ action_id: string; value?: string }>; response_url?: string }
interface SocketFrame { type: string; envelope_id?: string; payload?: { type?: string; event?: SlackEvent } & Partial<BlockActions>; reason?: string }

export class SlackAdapter implements TransportAdapter {
  readonly platformId = "slack";
  readonly name = "Slack (Web API + Socket Mode / Events API)";
  readonly apiVersion = "Web API + Socket Mode, unversioned (Slack ships no version segment); blocks kit v1";
  private readonly fetch: typeof fetch;
  private messageHandler?: InboundHandler;
  private callbackHandler?: CallbackHandler;
  private reactionHandler?: ReactionHandler;
  private ws?: WebSocket;
  private running = false;

  constructor(private readonly ctx: AdapterContext) {
    this.fetch = ctx.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private botToken(): string {
    const t = readSetting(this.ctx, "SLACK_BOT_TOKEN");
    if (!t) throw new TransportError("slack: SLACK_BOT_TOKEN is not set", "slack");
    return t;
  }

  private secrets(): string[] {
    return [readSetting(this.ctx, "SLACK_BOT_TOKEN"), readSetting(this.ctx, "SLACK_APP_TOKEN"), readSetting(this.ctx, "SLACK_SIGNING_SECRET")].filter((s): s is string => !!s);
  }

  private async api<T extends SlackEnvelope>(method: string, body: unknown, token = this.botToken(), timeoutMs?: number): Promise<T> {
    const res = await httpRequest<T>(this.fetch, "slack", `${baseUrlFor(this.ctx, "slack", SLACK_API)}/api/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
      timeoutMs,
    }, this.secrets());
    const env = expectOk("slack", res, this.secrets());
    if (!env.ok) throw new TransportError(`slack: ${method} failed: ${env.error ?? "unknown"}`, "slack", res.status);
    return env;
  }

  isConfigured(): boolean {
    return readSetting(this.ctx, "SLACK_BOT_TOKEN") !== undefined;
  }

  capabilities(): Capabilities {
    return { text: true, images: true, files: true, threads: true, reactions: true, buttons: true, typing: false };
  }

  onMessage(handler: InboundHandler): void { this.messageHandler = handler; }
  onCallback(handler: CallbackHandler): void { this.callbackHandler = handler; }
  onReaction(handler: ReactionHandler): void { this.reactionHandler = handler; }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const appToken = readSetting(this.ctx, "SLACK_APP_TOKEN");
    if (!appToken) return; // Events API mode: inbound via handleWebhook
    await this.connectSocket(appToken);
  }

  private async connectSocket(appToken: string): Promise<void> {
    const opened = await this.api<SlackEnvelope>("apps.connections.open", {}, appToken);
    if (!opened.url) throw new TransportError("slack: apps.connections.open returned no url", "slack");
    const ws = new WebSocket(opened.url);
    this.ws = ws;
    const logger = this.ctx.logger ?? SILENT_LOGGER;
    ws.addEventListener("message", (ev) => {
      void this.onFrame(String(ev.data)).catch((err: unknown) => logger.warn("slack frame error", { error: String(err) }));
    });
    ws.addEventListener("close", () => {
      if (this.running) setTimeout(() => { void this.connectSocket(appToken).catch(() => undefined); }, 2000);
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new TransportError("slack: socket connect failed", "slack")), { once: true });
    });
  }

  private async onFrame(text: string): Promise<void> {
    const frame = JSON.parse(text) as SocketFrame;
    if (frame.type === "disconnect") { this.ws?.close(); return; }
    if (frame.envelope_id) this.ws?.send(JSON.stringify({ envelope_id: frame.envelope_id }));
    if (frame.type === "events_api" && frame.payload?.event) await this.dispatchEvent(frame.payload.event);
    if (frame.type === "interactive" && frame.payload?.type === "block_actions") {
      await this.dispatchActions(frame.payload as BlockActions, frame.envelope_id ?? "");
    }
  }

  private async dispatchEvent(ev: SlackEvent): Promise<void> {
    if (ev.type === "reaction_added") { await this.dispatchReaction(ev as unknown as SlackReactionEvent); return; }
    if (ev.type !== "message" || ev.bot_id || ev.subtype === "bot_message" || !ev.user) return;
    const msg: InboundMessage = {
      id: ev.ts,
      platform: "slack",
      channelId: ev.channel,
      senderId: ev.user,
      content: ev.text ?? "",
      timestamp: new Date(Number(ev.ts.split(".")[0]) * 1000).toISOString(),
      scope: ev.channel_type === "im" ? "dm" : "group",
      threadId: ev.thread_ts,
    };
    await this.messageHandler?.(msg);
  }

  /** Only reactions on messages carry a channel and ts. Whether the reactor may decide is the bridge's call. */
  private async dispatchReaction(ev: SlackReactionEvent): Promise<void> {
    if (ev.item.type !== "message" || !ev.item.channel || !ev.item.ts || !ev.user) return;
    const reaction: InboundReaction = {
      platform: "slack",
      channelId: ev.item.channel,
      messageId: ev.item.ts,
      emoji: ev.reaction,
      senderId: ev.user,
      scope: ev.item.channel.startsWith("D") ? "dm" : "group",
    };
    await this.reactionHandler?.(reaction);
  }

  private async dispatchActions(p: BlockActions, callbackId: string): Promise<void> {
    for (const action of p.actions) {
      const cb: ButtonCallback = {
        platform: "slack",
        callbackId,
        senderId: p.user.id,
        channelId: p.channel?.id ?? p.user.id,
        scope: p.channel?.id?.startsWith("D") ? "dm" : "group",
        actionId: action.value ?? action.action_id,
        raw: p,
      };
      const ack = (await this.callbackHandler?.(cb)) ?? { ok: false, text: "No handler." };
      if (p.response_url) {
        await httpRequest(this.fetch, "slack", p.response_url, { method: "POST", body: { text: ack.text, replace_original: false, response_type: "ephemeral" } }, this.secrets());
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.ws?.close();
    this.ws = undefined;
  }

  async send(message: OutboundMessage): Promise<SendReceipt> {
    const body: Record<string, unknown> = { channel: message.channelId, text: message.text };
    if (message.threadId) body.thread_ts = message.threadId;
    if (message.buttons && message.buttons.length > 0) {
      body.blocks = [
        { type: "section", text: { type: "mrkdwn", text: message.text } },
        ...message.buttons.map((row) => ({
          type: "actions",
          elements: row.map((b) => ({
            type: "button",
            text: { type: "plain_text", text: b.label },
            action_id: b.id,
            value: b.id,
            ...(b.style && b.style !== "default" ? { style: b.style } : {}),
          })),
        })),
      ];
    }
    const res = await this.api<SlackEnvelope>("chat.postMessage", body);
    for (const a of message.attachments ?? []) await this.upload(message.channelId, a.filename, a.data, message.threadId);
    return { platform: "slack", messageId: res.ts ?? "" };
  }

  /** files.getUploadURLExternal -> POST bytes -> files.completeUploadExternal (the v2 flow). */
  private async upload(channel: string, filename: string, data: Uint8Array | string, threadTs?: string): Promise<void> {
    if (typeof data === "string") { await this.api("chat.postMessage", { channel, text: data, ...(threadTs ? { thread_ts: threadTs } : {}) }); return; }
    const params = new URLSearchParams({ filename, length: String(data.byteLength) });
    const ticket = await httpRequest<{ ok: boolean; upload_url?: string; file_id?: string }>(this.fetch, "slack", `${baseUrlFor(this.ctx, "slack", SLACK_API)}/api/files.getUploadURLExternal?${params}`, {
      method: "GET", headers: { authorization: `Bearer ${this.botToken()}` },
    }, this.secrets());
    const t = expectOk("slack", ticket, this.secrets());
    if (!t.ok || !t.upload_url || !t.file_id) throw new TransportError("slack: getUploadURLExternal failed", "slack");
    expectOk("slack", await httpRequest(this.fetch, "slack", t.upload_url, { method: "POST", body: data }), this.secrets());
    await this.api("files.completeUploadExternal", { files: [{ id: t.file_id, title: filename }], channel_id: channel, ...(threadTs ? { thread_ts: threadTs } : {}) });
  }

  async react(channel: string, timestamp: string, name: string): Promise<void> {
    await this.api("reactions.add", { channel, timestamp, name });
  }

  async health(): Promise<HealthStatus> {
    if (!this.isConfigured()) return { platform: "slack", state: "stopped", checkedAt: nowIso(), detail: "not configured" };
    const started = Date.now();
    try {
      const me = await this.api<SlackEnvelope>("auth.test", {}, this.botToken(), 10_000);
      const socketWanted = readSetting(this.ctx, "SLACK_APP_TOKEN") !== undefined;
      const socketUp = !socketWanted || this.ws?.readyState === WebSocket.OPEN;
      return { platform: "slack", state: this.running && socketUp ? "up" : "degraded", checkedAt: nowIso(), latencyMs: Date.now() - started, detail: `${me.user ?? "?"}@${me.team ?? "?"}` };
    } catch (err) {
      return { platform: "slack", state: "down", checkedAt: nowIso(), latencyMs: Date.now() - started, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Events API + interactivity endpoint. Rejects anything not signed by the signing secret. */
  async handleWebhook(request: WebhookRequest): Promise<WebhookResponse> {
    const secret = readSetting(this.ctx, "SLACK_SIGNING_SECRET");
    const ts = request.headers["x-slack-request-timestamp"];
    const sig = request.headers["x-slack-signature"];
    if (!secret || !ts || !sig) return { status: 401, body: "unsigned" };
    if (Math.abs(Date.now() / 1000 - Number(ts)) > SLACK_SIGNATURE_MAX_AGE_S) return { status: 401, body: "stale" };
    const expected = "v0=" + crypto.createHmac("sha256", secret).update(`v0:${ts}:${request.body}`).digest("hex");
    const a = Buffer.from(expected);
    const b = Buffer.from(sig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { status: 401, body: "bad signature" };

    const contentType = request.headers["content-type"] ?? "";
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const payload = new URLSearchParams(request.body).get("payload");
      if (payload) {
        const p = JSON.parse(payload) as BlockActions;
        if (p.type === "block_actions") await this.dispatchActions(p, "events-api");
      }
      return { status: 200, body: "" };
    }
    const body = JSON.parse(request.body) as { type: string; challenge?: string; event?: SlackEvent };
    if (body.type === "url_verification") return { status: 200, body: JSON.stringify({ challenge: body.challenge }), headers: { "content-type": "application/json" } };
    if (body.type === "event_callback" && body.event) await this.dispatchEvent(body.event);
    return { status: 200, body: "" };
  }
}
