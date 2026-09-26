/**
 * [H4] LINE Messaging API with a channel access token (`LINE_CHANNEL_ACCESS_TOKEN`); inbound is
 * the webhook only, signed with the channel secret (`LINE_CHANNEL_SECRET`) and served by the
 * gateway's WebhookServer at `/webhooks/line`. Endpoints, each from
 * https://developers.line.biz/en/reference/messaging-api/:
 *   GET  https://api.line.me/v2/bot/info                              #get-bot-info
 *   POST https://api.line.me/v2/bot/message/reply                     #send-reply-message
 *   POST https://api.line.me/v2/bot/message/push (X-Line-Retry-Key)   #send-push-message
 *   GET  https://api-data.line.me/v2/bot/message/{messageId}/content  #get-content
 *   webhook: X-Line-Signature = base64(HMAC-SHA256(channel secret, raw body)), #signature-validation
 *   (https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/); message and
 *   postback events (#message-event, #postback-event); quick reply, at most 13 postback items
 *   (#items-object, https://developers.line.biz/en/docs/messaging-api/using-quick-reply/).
 * Duplicates are detected by `webhookEventId`, as LINE advises for redelivered events
 * (https://developers.line.biz/en/docs/messaging-api/receiving-messages/). LINE has no reaction
 * API for bots and no threads; a card's buttons are quick-reply postbacks.
 */

import crypto from "node:crypto";
import {
  baseUrlFor,
  INBOUND_DOWNLOAD_TIMEOUT_MS,
  readSetting,
  SILENT_LOGGER,
  type AdapterContext,
  type ButtonCallback,
  type CallbackHandler,
  type Capabilities,
  type HealthStatus,
  type InboundAttachment,
  type InboundHandler,
  type InboundMessage,
  type OutboundMessage,
  type Scope,
  type SendReceipt,
  type TransportAdapter,
  type WebhookRequest,
  type WebhookResponse,
} from "../transport/types.js";
import { buttonsAsText, expectOk, httpRequest, nowIso, redact, TransportError, unsentAttachmentsAsText } from "../transport/http.js";

export const LINE_API = "https://api.line.me";
export const LINE_DATA_API = "https://api-data.line.me";
/** Webhook event ids already handled, newest last, in `GatewayStore.cursors` (a JSON array). */
export const LINE_SEEN_CURSOR = "line.seen";
export const LINE_SEEN_MAX = 512;
/** A reply token is single-use and short-lived; past this age a send pushes instead. */
export const LINE_REPLY_TOKEN_MAX_AGE_MS = 50_000;
const MAX_MESSAGES = 5;
const MAX_TEXT_CHARS = 5000;
const MAX_QUICK_REPLIES = 13;
const MAX_LABEL_CHARS = 20;
const MAX_POSTBACK_DATA_CHARS = 300;

interface LineSource { type: "user" | "group" | "room"; userId?: string; groupId?: string; roomId?: string }
interface LineEvent {
  type: string; mode?: "active" | "standby"; timestamp: number; webhookEventId?: string; source?: LineSource; replyToken?: string;
  message?: { id: string; type: string; text?: string; duration?: number; contentProvider?: { type: string } };
  postback?: { data: string };
}
interface SentMessages { sentMessages?: Array<{ id: string }> }
type LineMessage = Record<string, unknown>;

export class LineAdapter implements TransportAdapter {
  readonly platformId = "line";
  readonly name = "LINE Messaging API";
  readonly apiVersion = "Messaging API v2";
  private readonly fetch: typeof fetch;
  private messageHandler?: InboundHandler;
  private callbackHandler?: CallbackHandler;
  private running = false;
  /** The latest unused reply token per chat, so the next send answers for free instead of pushing. */
  private readonly replyTokens = new Map<string, { token: string; at: number }>();

  constructor(private readonly ctx: AdapterContext) {
    this.fetch = ctx.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private token(): string {
    const t = readSetting(this.ctx, "LINE_CHANNEL_ACCESS_TOKEN");
    if (!t) throw new TransportError("line: LINE_CHANNEL_ACCESS_TOKEN is not set", "line");
    return t;
  }

  private secrets(): string[] {
    return [readSetting(this.ctx, "LINE_CHANNEL_ACCESS_TOKEN"), readSetting(this.ctx, "LINE_CHANNEL_SECRET")].filter((s): s is string => !!s);
  }

  private async api<T>(method: "GET" | "POST", path: string, body?: unknown, headers: Record<string, string> = {}, timeoutMs?: number): Promise<T> {
    const res = await httpRequest<T>(this.fetch, "line", `${baseUrlFor(this.ctx, "line", LINE_API)}${path}`, { method, body, timeoutMs, headers: { authorization: `Bearer ${this.token()}`, ...headers } }, this.secrets());
    return expectOk("line", res, this.secrets());
  }

  isConfigured(): boolean {
    return readSetting(this.ctx, "LINE_CHANNEL_ACCESS_TOKEN") !== undefined && readSetting(this.ctx, "LINE_CHANNEL_SECRET") !== undefined;
  }

  capabilities(): Capabilities {
    return { text: true, images: false, files: false, threads: false, reactions: false, buttons: true, typing: false };
  }

  onMessage(handler: InboundHandler): void { this.messageHandler = handler; }
  onCallback(handler: CallbackHandler): void { this.callbackHandler = handler; }

  async start(): Promise<void> {
    if (this.running) return;
    await this.api("GET", "/v2/bot/info");
    this.running = true; // inbound arrives through handleWebhook
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  /**
   * The signature is checked on the raw body before it is parsed; a bad or missing one is 401 and
   * nothing is read. Each event is marked seen (persisted) before it is dispatched, so a
   * redelivery, or the same event after a restart, is dropped: at most once. Dispatch runs after
   * the 200, as LINE recommends, so a long run never holds the webhook open.
   */
  async handleWebhook(request: WebhookRequest): Promise<WebhookResponse> {
    if (request.method !== "POST") return { status: 405, body: "method not allowed" };
    const secret = readSetting(this.ctx, "LINE_CHANNEL_SECRET");
    const signature = request.headers["x-line-signature"] ?? "";
    if (!secret) return { status: 401, body: "LINE_CHANNEL_SECRET not set" };
    const expected = Buffer.from(crypto.createHmac("sha256", secret).update(request.body, "utf8").digest("base64"));
    const got = Buffer.from(signature);
    if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) return { status: 401, body: "bad signature" };
    let payload: { events?: LineEvent[] };
    try {
      payload = JSON.parse(request.body) as { events?: LineEvent[] };
    } catch {
      return { status: 400, body: "bad json" };
    }
    const fresh = this.claim(Array.isArray(payload.events) ? payload.events : []);
    const logger = this.ctx.logger ?? SILENT_LOGGER;
    void (async () => {
      for (const event of fresh) await this.dispatch(event);
    })().catch((err: unknown) => logger.warn("line dispatch error", { error: redact(err instanceof Error ? err.message : String(err), this.secrets()) }));
    return { status: 200, body: "ok" };
  }

  /** Returns the events not seen before and records their ids, in one store mutation. */
  private claim(events: LineEvent[]): LineEvent[] {
    return this.ctx.store.mutate((s) => {
      let seen: string[] = [];
      try {
        const parsed = JSON.parse(s.cursors[LINE_SEEN_CURSOR] ?? "[]") as unknown;
        if (Array.isArray(parsed)) seen = parsed.filter((x): x is string => typeof x === "string");
      } catch {
        seen = [];
      }
      const known = new Set(seen);
      const fresh = events.filter((e) => {
        if (!e.webhookEventId) return true;
        if (known.has(e.webhookEventId)) return false;
        known.add(e.webhookEventId);
        seen.push(e.webhookEventId);
        return true;
      });
      s.cursors[LINE_SEEN_CURSOR] = JSON.stringify(seen.slice(-LINE_SEEN_MAX));
      return fresh;
    });
  }

  private address(source: LineSource | undefined): { channelId: string; senderId: string; scope: Scope } | undefined {
    if (!source?.userId) return undefined; // no user to pair
    if (source.type === "group" && source.groupId) return { channelId: source.groupId, senderId: source.userId, scope: "group" };
    if (source.type === "room" && source.roomId) return { channelId: source.roomId, senderId: source.userId, scope: "group" };
    return source.type === "user" ? { channelId: source.userId, senderId: source.userId, scope: "dm" } : undefined;
  }

  private async dispatch(event: LineEvent): Promise<void> {
    if (event.mode === "standby") return; // another channel owns the chat
    const where = this.address(event.source);
    if (!where) return;
    if (event.type === "postback" && event.postback) {
      const cb: ButtonCallback = { platform: "line", callbackId: event.webhookEventId ?? "", ...where, actionId: event.postback.data, raw: event };
      const ack = (await this.callbackHandler?.(cb)) ?? { ok: false, text: "No handler." };
      await this.deliver(where.channelId, [{ type: "text", text: ack.text }], event.replyToken);
      return;
    }
    const m = event.message;
    if (event.type !== "message" || !m) return;
    const attachments = m.type === "audio" && m.contentProvider?.type === "line" ? this.audioAttachments(m.id, m.duration) : undefined;
    if (m.type !== "text" && !attachments) return;
    if (event.replyToken) this.replyTokens.set(where.channelId, { token: event.replyToken, at: Date.now() });
    const msg: InboundMessage = { id: m.id, platform: "line", ...where, content: m.text ?? "", timestamp: new Date(event.timestamp).toISOString(), ...(attachments ? { attachments } : {}) };
    await this.messageHandler?.(msg);
  }

  /** [P2-3] An audio message, fetched from the data host with the channel token only when the gateway opens it. */
  private audioAttachments(messageId: string, durationMs: number | undefined): InboundAttachment[] | undefined {
    if (!/^\d+$/.test(messageId)) return undefined;
    return [{ kind: "audio", mime: "audio/mp4", ...(durationMs !== undefined ? { durationSeconds: durationMs / 1000 } : {}), open: () => this.openContent(messageId) }];
  }

  private async openContent(messageId: string): Promise<Response> {
    const token = this.token();
    try {
      return await this.fetch(`${baseUrlFor(this.ctx, "line-data", LINE_DATA_API)}/v2/bot/message/${messageId}/content`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(INBOUND_DOWNLOAD_TIMEOUT_MS) });
    } catch (err) {
      throw new TransportError(`line: voice note download failed: ${redact(err instanceof Error ? err.message : String(err), [token])}`, "line");
    }
  }

  /** Text in chunks of 5,000 characters, at most five message objects; quick replies ride on the last. */
  private messages(message: OutboundMessage): LineMessage[] {
    const buttons = (message.buttons ?? []).flat();
    const quick = buttons.length > 0 && buttons.length <= MAX_QUICK_REPLIES && buttons.every((b) => b.label.length <= MAX_LABEL_CHARS && b.id.length <= MAX_POSTBACK_DATA_CHARS);
    let text = message.text + (quick ? "" : buttonsAsText(message.buttons)) + unsentAttachmentsAsText(message.attachments);
    if (text === "") text = " ";
    const chunks: string[] = [];
    for (let i = 0; i < text.length && chunks.length < MAX_MESSAGES; i += MAX_TEXT_CHARS) chunks.push(text.slice(i, i + MAX_TEXT_CHARS));
    const out: LineMessage[] = chunks.map((chunk) => ({ type: "text", text: chunk }));
    if (quick) {
      out[out.length - 1]!.quickReply = { items: buttons.map((b) => ({ type: "action", action: { type: "postback", label: b.label, data: b.id, displayText: b.label } })) };
    }
    return out;
  }

  /** Reply with a fresh token when one is held (single use), else push; a refused reply falls back to push. */
  private async deliver(to: string, messages: LineMessage[], replyToken?: string): Promise<string> {
    const held = this.replyTokens.get(to);
    let token = replyToken;
    if (!token && held && Date.now() - held.at < LINE_REPLY_TOKEN_MAX_AGE_MS) token = held.token;
    if (!replyToken) this.replyTokens.delete(to);
    if (token) {
      try {
        const replied = await this.api<SentMessages>("POST", "/v2/bot/message/reply", { replyToken: token, messages });
        return replied.sentMessages?.at(-1)?.id ?? "";
      } catch (err) {
        if (!(err instanceof TransportError) || err.status !== 400) throw err; // an expired or used token is a 400
      }
    }
    const pushed = await this.api<SentMessages>("POST", "/v2/bot/message/push", { to, messages }, { "x-line-retry-key": crypto.randomUUID() });
    return pushed.sentMessages?.at(-1)?.id ?? "";
  }

  async send(message: OutboundMessage): Promise<SendReceipt> {
    return { platform: "line", messageId: await this.deliver(message.channelId, this.messages(message)) };
  }

  async health(): Promise<HealthStatus> {
    if (!this.isConfigured()) return { platform: "line", state: "stopped", checkedAt: nowIso(), detail: "not configured" };
    const started = Date.now();
    try {
      const info = await this.api<{ displayName?: string; basicId?: string }>("GET", "/v2/bot/info", undefined, {}, 10_000);
      return { platform: "line", state: this.running ? "up" : "degraded", checkedAt: nowIso(), latencyMs: Date.now() - started, detail: `${info.displayName ?? "?"} ${info.basicId ?? ""}`.trim() };
    } catch (err) {
      return { platform: "line", state: "down", checkedAt: nowIso(), latencyMs: Date.now() - started, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}
