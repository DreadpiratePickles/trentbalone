/**
 * Home Assistant. Outbound: REST `POST /api/services/notify/<service>` (channel
 * `notify:<service>`) or an HA webhook trigger `POST /api/webhook/<id>` (channel
 * `webhook:<id>`). Inbound: an HA automation with a `rest_command` posts to our
 * `/webhooks/homeassistant` carrying the shared secret header.
 * https://developers.home-assistant.io/docs/api/rest/
 */

import crypto from "node:crypto";
import {
  baseUrlFor,
  readSetting,
  type AdapterContext,
  type CallbackHandler,
  type Capabilities,
  type HealthStatus,
  type InboundHandler,
  type InboundMessage,
  type OutboundMessage,
  type SendReceipt,
  type TransportAdapter,
  type WebhookRequest,
  type WebhookResponse,
} from "../transport/types.js";
import { buttonsAsText, expectOk, httpRequest, nowIso, TransportError } from "../transport/http.js";

export const HASS_SECRET_HEADER = "x-trent-webhook-secret";

export class HomeAssistantAdapter implements TransportAdapter {
  readonly platformId = "homeassistant";
  readonly name = "Home Assistant (REST + webhook)";
  readonly apiVersion = "REST API (unversioned; verified against core 2025.8)";
  private readonly fetch: typeof fetch;
  private messageHandler?: InboundHandler;
  private running = false;

  constructor(private readonly ctx: AdapterContext) {
    this.fetch = ctx.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private base(): string {
    const url = readSetting(this.ctx, "HASS_URL");
    if (!url) throw new TransportError("homeassistant: HASS_URL is not set", "homeassistant");
    return baseUrlFor(this.ctx, "homeassistant", url);
  }

  private token(): string {
    const t = readSetting(this.ctx, "HASS_TOKEN");
    if (!t) throw new TransportError("homeassistant: HASS_TOKEN is not set", "homeassistant");
    return t;
  }

  private async api<T>(method: "GET" | "POST", path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    const token = this.token();
    const res = await httpRequest<T>(this.fetch, "homeassistant", `${this.base()}${path}`, { method, body, timeoutMs, headers: { authorization: `Bearer ${token}` } }, [token]);
    return expectOk("homeassistant", res, [token]);
  }

  isConfigured(): boolean {
    return readSetting(this.ctx, "HASS_URL") !== undefined && readSetting(this.ctx, "HASS_TOKEN") !== undefined;
  }

  capabilities(): Capabilities {
    return { text: true, images: false, files: false, threads: false, reactions: false, buttons: false, typing: false };
  }

  onMessage(handler: InboundHandler): void { this.messageHandler = handler; }
  onCallback(_handler: CallbackHandler): void { /* no interactive surface */ }
  async start(): Promise<void> { this.running = true; }
  async stop(): Promise<void> { this.running = false; }

  async send(message: OutboundMessage): Promise<SendReceipt> {
    const text = message.text + buttonsAsText(message.buttons);
    const id = `ha_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
    if (message.channelId.startsWith("webhook:")) {
      await this.api("POST", `/api/webhook/${encodeURIComponent(message.channelId.slice(8))}`, { text, ...(message.metadata ?? {}) });
      return { platform: "homeassistant", messageId: id };
    }
    const service = message.channelId.replace(/^notify:/, "") || "notify";
    const title = typeof message.metadata?.title === "string" ? { title: message.metadata.title } : {};
    await this.api("POST", `/api/services/notify/${encodeURIComponent(service)}`, { message: text, ...title });
    return { platform: "homeassistant", messageId: id };
  }

  async health(): Promise<HealthStatus> {
    if (!this.isConfigured()) return { platform: "homeassistant", state: "stopped", checkedAt: nowIso(), detail: "not configured" };
    const started = Date.now();
    try {
      await this.api<{ message: string }>("GET", "/api/", undefined, 10_000);
      const cfg = await this.api<{ version?: string; location_name?: string }>("GET", "/api/config", undefined, 10_000);
      return { platform: "homeassistant", state: this.running ? "up" : "degraded", checkedAt: nowIso(), latencyMs: Date.now() - started, detail: `core ${cfg.version ?? "?"} (${cfg.location_name ?? "?"})` };
    } catch (err) {
      return { platform: "homeassistant", state: "down", checkedAt: nowIso(), latencyMs: Date.now() - started, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Body: `{ "text": "...", "sender": "automation.x", "channel": "notify:service" }`. */
  async handleWebhook(request: WebhookRequest): Promise<WebhookResponse> {
    const secret = readSetting(this.ctx, "HASS_WEBHOOK_SECRET");
    const got = request.headers[HASS_SECRET_HEADER] ?? "";
    if (!secret || got.length !== secret.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(secret))) return { status: 403, body: "forbidden" };
    let body: { text?: string; sender?: string; channel?: string };
    try {
      body = JSON.parse(request.body) as typeof body;
    } catch {
      return { status: 400, body: "bad json" };
    }
    if (typeof body.text !== "string") return { status: 400, body: "text required" };
    const msg: InboundMessage = {
      id: `ha_in_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`,
      platform: "homeassistant",
      channelId: body.channel ?? "notify:notify",
      senderId: body.sender ?? "homeassistant",
      content: body.text,
      timestamp: nowIso(),
      scope: "dm",
    };
    await this.messageHandler?.(msg);
    return { status: 200, body: "ok" };
  }
}
