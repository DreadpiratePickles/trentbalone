/**
 * WhatsApp Cloud API (Meta Graph API). Outbound via POST /{version}/{phone_number_id}/messages;
 * inbound via the Meta webhook (GET verification handshake, POST signed with X-Hub-Signature-256).
 * https://developers.facebook.com/docs/whatsapp/cloud-api
 */

import crypto from "node:crypto";
import {
  baseUrlFor,
  INBOUND_DOWNLOAD_TIMEOUT_MS,
  isPinnedDownloadUrl,
  readSetting,
  type AdapterContext,
  type ButtonCallback,
  type CallbackHandler,
  type Capabilities,
  type HealthStatus,
  type InboundAttachment,
  type InboundHandler,
  type InboundMessage,
  type OutboundMessage,
  type SendReceipt,
  type TransportAdapter,
  type WebhookRequest,
  type WebhookResponse,
} from "../transport/types.js";
import { toBlobPart, buttonsAsText, expectOk, httpRequest, nowIso, redact, TransportError } from "../transport/http.js";

export const WHATSAPP_GRAPH = "https://graph.facebook.com";
export const WHATSAPP_GRAPH_VERSION = "v22.0";
/** Reply buttons: at most three, titles at most 20 characters. */
const MAX_REPLY_BUTTONS = 3;
/** Where the Graph API's media URLs point; the token is sent to no other host. */
export const WHATSAPP_MEDIA_HOSTS = ["lookaside.fbsbx.com"] as const;

interface WaSendResponse { messages?: Array<{ id: string }> }
interface WaMessage { from: string; id: string; timestamp: string; type: string; text?: { body: string }; interactive?: { type: string; button_reply?: { id: string; title: string } }; image?: { caption?: string }; document?: { caption?: string }; audio?: { id: string; mime_type?: string; sha256?: string; voice?: boolean } }
interface WaWebhook { object: string; entry?: Array<{ changes?: Array<{ field: string; value: { contacts?: Array<{ profile?: { name?: string }; wa_id: string }>; messages?: WaMessage[] } }> }> }

export class WhatsAppAdapter implements TransportAdapter {
  readonly platformId = "whatsapp";
  readonly name = "WhatsApp Cloud API";
  readonly apiVersion = WHATSAPP_GRAPH_VERSION;
  private readonly fetch: typeof fetch;
  private messageHandler?: InboundHandler;
  private callbackHandler?: CallbackHandler;
  private running = false;

  constructor(private readonly ctx: AdapterContext) {
    this.fetch = ctx.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private token(): string {
    const t = readSetting(this.ctx, "WHATSAPP_TOKEN");
    if (!t) throw new TransportError("whatsapp: WHATSAPP_TOKEN is not set", "whatsapp");
    return t;
  }

  private phoneId(): string {
    const id = readSetting(this.ctx, "WHATSAPP_PHONE_NUMBER_ID");
    if (!id) throw new TransportError("whatsapp: WHATSAPP_PHONE_NUMBER_ID is not set", "whatsapp");
    return id;
  }

  private async graph<T>(method: "GET" | "POST", path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    const token = this.token();
    const res = await httpRequest<T>(this.fetch, "whatsapp", `${baseUrlFor(this.ctx, "whatsapp", WHATSAPP_GRAPH)}/${WHATSAPP_GRAPH_VERSION}${path}`, {
      method, body, timeoutMs, headers: { authorization: `Bearer ${token}` },
    }, [token, readSetting(this.ctx, "WHATSAPP_APP_SECRET")]);
    return expectOk("whatsapp", res, [token]);
  }

  isConfigured(): boolean {
    return readSetting(this.ctx, "WHATSAPP_TOKEN") !== undefined && readSetting(this.ctx, "WHATSAPP_PHONE_NUMBER_ID") !== undefined;
  }

  capabilities(): Capabilities {
    return { text: true, images: true, files: true, threads: false, reactions: true, buttons: true, typing: true };
  }

  onMessage(handler: InboundHandler): void { this.messageHandler = handler; }
  onCallback(handler: CallbackHandler): void { this.callbackHandler = handler; }

  async start(): Promise<void> { this.running = true; } // inbound is webhook-only
  async stop(): Promise<void> { this.running = false; }

  private async post(payload: Record<string, unknown>): Promise<string> {
    const res = await this.graph<WaSendResponse>("POST", `/${this.phoneId()}/messages`, { messaging_product: "whatsapp", recipient_type: "individual", ...payload });
    return res.messages?.[0]?.id ?? "";
  }

  async send(message: OutboundMessage): Promise<SendReceipt> {
    const to = message.channelId;
    let id = "";
    const buttons = (message.buttons ?? []).flat();
    if (buttons.length > 0 && buttons.length <= MAX_REPLY_BUTTONS && buttons.every((b) => b.label.length <= 20)) {
      id = await this.post({ to, type: "interactive", interactive: { type: "button", body: { text: message.text }, action: { buttons: buttons.map((b) => ({ type: "reply", reply: { id: b.id, title: b.label } })) } } });
    } else {
      id = await this.post({ to, type: "text", text: { preview_url: false, body: message.text + buttonsAsText(buttons.length > MAX_REPLY_BUTTONS ? message.buttons : undefined) } });
    }
    for (const a of message.attachments ?? []) {
      const kind = a.contentType.startsWith("image/") ? "image" : "document";
      const ref = typeof a.data === "string" ? { link: a.data } : { id: await this.uploadMedia(a.filename, a.contentType, a.data) };
      id = await this.post({ to, type: kind, [kind]: { ...ref, ...(kind === "document" ? { filename: a.filename } : {}) } });
    }
    return { platform: "whatsapp", messageId: id };
  }

  private async uploadMedia(filename: string, contentType: string, data: Uint8Array): Promise<string> {
    const form = new FormData();
    form.set("messaging_product", "whatsapp");
    form.set("type", contentType);
    form.set("file", new Blob([toBlobPart(data)], { type: contentType }), filename);
    const res = await this.graph<{ id: string }>("POST", `/${this.phoneId()}/media`, form);
    return res.id;
  }

  async react(to: string, messageId: string, emoji: string): Promise<void> {
    await this.post({ to, type: "reaction", reaction: { message_id: messageId, emoji } });
  }

  /** Marks the message read and shows the typing indicator (Cloud API, 2025). */
  async sendTyping(messageId: string): Promise<void> {
    await this.graph("POST", `/${this.phoneId()}/messages`, { messaging_product: "whatsapp", status: "read", message_id: messageId, typing_indicator: { type: "text" } });
  }

  async health(): Promise<HealthStatus> {
    if (!this.isConfigured()) return { platform: "whatsapp", state: "stopped", checkedAt: nowIso(), detail: "not configured" };
    const started = Date.now();
    try {
      const info = await this.graph<{ verified_name?: string; display_phone_number?: string }>("GET", `/${this.phoneId()}`, undefined, 10_000);
      return { platform: "whatsapp", state: this.running ? "up" : "degraded", checkedAt: nowIso(), latencyMs: Date.now() - started, detail: `${info.verified_name ?? "?"} ${info.display_phone_number ?? ""}`.trim() };
    } catch (err) {
      return { platform: "whatsapp", state: "down", checkedAt: nowIso(), latencyMs: Date.now() - started, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  async handleWebhook(request: WebhookRequest): Promise<WebhookResponse> {
    if (request.method === "GET") {
      const q = new URL(request.url, "http://localhost").searchParams;
      const expected = readSetting(this.ctx, "WHATSAPP_VERIFY_TOKEN");
      if (q.get("hub.mode") === "subscribe" && expected && q.get("hub.verify_token") === expected) {
        return { status: 200, body: q.get("hub.challenge") ?? "", headers: { "content-type": "text/plain" } };
      }
      return { status: 403, body: "forbidden" };
    }
    const secret = readSetting(this.ctx, "WHATSAPP_APP_SECRET");
    const sig = request.headers["x-hub-signature-256"] ?? "";
    if (!secret) return { status: 401, body: "WHATSAPP_APP_SECRET not set" };
    const expected = "sha256=" + crypto.createHmac("sha256", secret).update(request.body).digest("hex");
    const a = Buffer.from(expected);
    const b = Buffer.from(sig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { status: 401, body: "bad signature" };
    let payload: WaWebhook;
    try {
      payload = JSON.parse(request.body) as WaWebhook;
    } catch {
      return { status: 400, body: "bad json" };
    }
    if (payload.object !== "whatsapp_business_account") return { status: 200, body: "ignored" };
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const names = new Map((change.value.contacts ?? []).map((c) => [c.wa_id, c.profile?.name]));
        for (const m of change.value.messages ?? []) await this.dispatch(m, names.get(m.from));
      }
    }
    return { status: 200, body: "ok" };
  }

  private async dispatch(m: WaMessage, senderName?: string): Promise<void> {
    const timestamp = new Date(Number(m.timestamp) * 1000).toISOString();
    if (m.type === "interactive" && m.interactive?.type === "button_reply" && m.interactive.button_reply) {
      const cb: ButtonCallback = { platform: "whatsapp", callbackId: m.id, senderId: m.from, channelId: m.from, scope: "dm", actionId: m.interactive.button_reply.id, raw: m };
      const ack = (await this.callbackHandler?.(cb)) ?? { ok: false, text: "No handler." };
      await this.post({ to: m.from, type: "text", text: { preview_url: false, body: ack.text } });
      return;
    }
    const content = m.text?.body ?? m.image?.caption ?? m.document?.caption ?? "";
    const attachments = this.audioAttachments(m);
    const msg: InboundMessage = { id: m.id, platform: "whatsapp", channelId: m.from, senderId: m.from, senderName, content, timestamp, scope: "dm", metadata: { type: m.type }, ...(attachments ? { attachments } : {}) };
    await this.messageHandler?.(msg);
  }

  /** [P2-3] A voice note or audio message, carried lazily: the media lookup and download run only when the gateway opens it. */
  private audioAttachments(m: WaMessage): InboundAttachment[] | undefined {
    const media = m.type === "audio" ? m.audio : undefined;
    if (!media?.id) return undefined;
    return [{ kind: "audio", mime: media.mime_type ?? "audio/ogg", open: () => this.openMedia(media.id) }];
  }

  /** GET /{media-id} for the short-lived URL, then GET that URL with the same bearer token, on Meta's media host only. */
  private async openMedia(mediaId: string): Promise<Response> {
    if (!/^[A-Za-z0-9_-]+$/.test(mediaId)) throw new TransportError("whatsapp: malformed media id", "whatsapp");
    const info = await this.graph<{ url?: string }>("GET", `/${mediaId}`);
    const url = info.url ?? "";
    if (!isPinnedDownloadUrl(url, baseUrlFor(this.ctx, "whatsapp", WHATSAPP_GRAPH), WHATSAPP_MEDIA_HOSTS)) {
      let host = "an unparseable URL";
      try { host = new URL(url).hostname; } catch { /* keep the placeholder */ }
      throw new TransportError(`whatsapp: refusing to fetch a voice note from ${host}: not a WhatsApp media host`, "whatsapp");
    }
    const token = this.token();
    try {
      return await this.fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(INBOUND_DOWNLOAD_TIMEOUT_MS) });
    } catch (err) {
      throw new TransportError(`whatsapp: voice note download failed: ${redact(err instanceof Error ? err.message : String(err), [token])}`, "whatsapp");
    }
  }
}
