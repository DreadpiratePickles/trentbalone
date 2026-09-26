/**
 * [H4] ntfy as a phone notification channel with reply-by-topic. Trent publishes to `NTFY_TOPIC`
 * and reads replies from `NTFY_REPLY_TOPIC` (the same topic when unset) on `NTFY_URL`
 * (https://ntfy.sh by default), with an optional access token (`NTFY_TOKEN`). Endpoints, each
 * from https://docs.ntfy.sh/:
 *   POST /                   publish as JSON             publish/#publish-as-json
 *   GET  /<topic>/json       JSON stream, since=<id>     subscribe/api/#subscribe-as-json-stream,
 *                                                        subscribe/api/#fetch-cached-messages
 *   GET  /v1/health          {"healthy":true}            config/#health-checks
 *   Authorization: Bearer <token>                        publish/#access-tokens
 *   action buttons, at most three, `http` action        publish/#action-buttons, publish/#send-http-request
 * ntfy carries no sender identity: whoever can publish to the reply topic is the sender, so the
 * reply topic is what gets paired, and its name (or an ACL on a self-hosted server) is the
 * credential. A card's buttons are `http` actions that publish the button id to the reply topic;
 * they carry no Authorization header, because a notification is readable by everyone who can read
 * the topic and the token must never ride inside one. Trent tags what it publishes `robot` and
 * ignores that tag on the reply topic, so one topic can carry both directions.
 */

import {
  baseUrlFor,
  INBOUND_DOWNLOAD_TIMEOUT_MS,
  isPinnedDownloadUrl,
  readSetting,
  SILENT_LOGGER,
  type AdapterContext,
  type CallbackHandler,
  type Capabilities,
  type HealthStatus,
  type InboundAttachment,
  type InboundHandler,
  type InboundMessage,
  type OutboundMessage,
  type SendReceipt,
  type TransportAdapter,
} from "../transport/types.js";
import { buttonsAsText, expectOk, httpRequest, nowIso, redact, TransportError, unsentAttachmentsAsText } from "../transport/http.js";

export const NTFY_DEFAULT_URL = "https://ntfy.sh";
/** The id of the last message read from the reply topic, in `GatewayStore.cursors`. */
export const NTFY_SINCE_CURSOR = "ntfy.since";
/** The tag on everything Trent publishes (shown as a robot emoji); a message carrying it is not a reply. */
export const NTFY_OWN_TAG = "robot";
const MAX_ACTIONS = 3;
const TOPIC_RE = /^[-_A-Za-z0-9]{1,64}$/;

interface NtfyEvent { id?: string; time?: number; event?: string; topic?: string; message?: string; title?: string; tags?: string[]; attachment?: { name?: string; url?: string; type?: string; size?: number } }

export class NtfyAdapter implements TransportAdapter {
  readonly platformId = "ntfy";
  readonly name = "ntfy (publish + JSON stream)";
  readonly apiVersion = "ntfy HTTP API (JSON publish, /json stream)";
  private readonly fetch: typeof fetch;
  private messageHandler?: InboundHandler;
  private running = false;
  private abort?: AbortController;
  private stream?: Promise<void>;
  private connected = false;

  constructor(private readonly ctx: AdapterContext) {
    this.fetch = ctx.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private topic(): string {
    const t = readSetting(this.ctx, "NTFY_TOPIC");
    if (!t || !TOPIC_RE.test(t)) throw new TransportError("ntfy: NTFY_TOPIC is not set or is not a topic name", "ntfy");
    return t;
  }

  private replyTopic(): string {
    const t = readSetting(this.ctx, "NTFY_REPLY_TOPIC") ?? this.topic();
    if (!TOPIC_RE.test(t)) throw new TransportError("ntfy: NTFY_REPLY_TOPIC is not a topic name", "ntfy");
    return t;
  }

  private base(): string {
    return baseUrlFor(this.ctx, "ntfy", readSetting(this.ctx, "NTFY_URL") ?? NTFY_DEFAULT_URL);
  }

  private auth(): Record<string, string> {
    const token = readSetting(this.ctx, "NTFY_TOKEN");
    return token ? { authorization: `Bearer ${token}` } : {};
  }

  private secrets(): string[] {
    return [readSetting(this.ctx, "NTFY_TOKEN")].filter((s): s is string => !!s);
  }

  isConfigured(): boolean {
    return readSetting(this.ctx, "NTFY_TOPIC") !== undefined;
  }

  capabilities(): Capabilities {
    return { text: true, images: false, files: false, threads: false, reactions: false, buttons: true, typing: false };
  }

  onMessage(handler: InboundHandler): void { this.messageHandler = handler; }
  onCallback(_handler: CallbackHandler): void { /* a tapped action arrives as a reply-topic message, which the gateway reads as a decision */ }

  async start(): Promise<void> {
    if (this.running) return;
    this.replyTopic(); // validates both topic names before anything is opened
    this.running = true;
    this.abort = new AbortController();
    this.stream = this.consume(this.abort.signal);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abort?.abort();
    await this.stream?.catch(() => undefined);
    this.stream = undefined;
  }

  /**
   * One long-lived GET of `/<reply topic>/json`, resumed with `since=<last id>` after a restart or
   * a dropped connection, so a message is read once. With no stored id only new messages arrive.
   */
  private async consume(signal: AbortSignal): Promise<void> {
    const logger = this.ctx.logger ?? SILENT_LOGGER;
    while (this.running && !signal.aborted) {
      try {
        const since = this.ctx.store.snapshot().cursors[NTFY_SINCE_CURSOR];
        const query = since ? `?since=${encodeURIComponent(since)}` : "";
        const res = await this.fetch(`${this.base()}/${this.replyTopic()}/json${query}`, { headers: this.auth(), signal });
        if (!res.ok || !res.body) throw new TransportError(`ntfy: subscribe HTTP ${res.status}`, "ntfy", res.status);
        this.connected = true;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newline: number;
          while ((newline = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (line !== "") await this.onLine(line);
          }
        }
      } catch (err) {
        if (signal.aborted) return;
        logger.warn("ntfy stream error", { error: redact(err instanceof Error ? err.message : String(err), this.secrets()) });
      } finally {
        this.connected = false;
      }
      if (!signal.aborted) await new Promise((r) => setTimeout(r, 2000));
    }
  }

  private async onLine(line: string): Promise<void> {
    let event: NtfyEvent;
    try {
      event = JSON.parse(line) as NtfyEvent;
    } catch {
      return;
    }
    if (event.event !== "message" || !event.id) return; // open, keepalive, poll_request, deletes
    const id = event.id;
    this.ctx.store.mutate((s) => { s.cursors[NTFY_SINCE_CURSOR] = id; });
    if ((event.tags ?? []).includes(NTFY_OWN_TAG)) return;
    const attachments = this.audioAttachments(event.attachment);
    const msg: InboundMessage = {
      id,
      platform: "ntfy",
      channelId: this.topic(),
      senderId: event.topic ?? this.replyTopic(),
      content: event.message ?? "",
      timestamp: new Date((event.time ?? 0) * 1000).toISOString(),
      scope: "dm",
      ...(event.title ? { metadata: { subject: event.title } } : {}),
      ...(attachments ? { attachments } : {}),
    };
    await this.messageHandler?.(msg);
  }

  /** [P2-3] An audio file attached to a reply, fetched only from this ntfy server and only when opened. */
  private audioAttachments(attachment: NtfyEvent["attachment"]): InboundAttachment[] | undefined {
    if (!attachment?.url || !attachment.type?.toLowerCase().startsWith("audio/")) return undefined;
    const url = attachment.url;
    return [{ kind: "audio", mime: attachment.type, ...(attachment.size !== undefined ? { sizeBytes: attachment.size } : {}), open: () => this.openAttachment(url) }];
  }

  private async openAttachment(url: string): Promise<Response> {
    if (!isPinnedDownloadUrl(url, this.base(), [])) {
      let host = "an unparseable URL";
      try { host = new URL(url).hostname; } catch { /* keep the placeholder */ }
      throw new TransportError(`ntfy: refusing to fetch a voice note from ${host}: not this ntfy server`, "ntfy");
    }
    try {
      return await this.fetch(url, { headers: this.auth(), signal: AbortSignal.timeout(INBOUND_DOWNLOAD_TIMEOUT_MS) });
    } catch (err) {
      throw new TransportError(`ntfy: voice note download failed: ${redact(err instanceof Error ? err.message : String(err), this.secrets())}`, "ntfy");
    }
  }

  async send(message: OutboundMessage): Promise<SendReceipt> {
    const buttons = (message.buttons ?? []).flat();
    const asActions = buttons.length > 0 && buttons.length <= MAX_ACTIONS;
    const body: Record<string, unknown> = {
      topic: message.channelId,
      message: message.text + (asActions ? "" : buttonsAsText(message.buttons)) + unsentAttachmentsAsText(message.attachments),
    };
    const subject = message.metadata?.subject;
    if (typeof subject === "string" && subject !== "") body.title = subject;
    body.tags = [NTFY_OWN_TAG];
    if (asActions) {
      const url = `${this.base()}/${this.replyTopic()}`;
      body.actions = buttons.map((b) => ({ action: "http", label: b.label, url, method: "POST", body: b.id, clear: true }));
    }
    const res = await httpRequest<{ id?: string }>(this.fetch, "ntfy", `${this.base()}/`, { method: "POST", body, headers: this.auth() }, this.secrets());
    const published = expectOk("ntfy", res, this.secrets());
    if (!published?.id) throw new TransportError("ntfy: publish returned no message id", "ntfy", res.status);
    return { platform: "ntfy", messageId: published.id };
  }

  async health(): Promise<HealthStatus> {
    if (!this.isConfigured()) return { platform: "ntfy", state: "stopped", checkedAt: nowIso(), detail: "not configured" };
    const started = Date.now();
    try {
      const res = await httpRequest<{ healthy?: boolean }>(this.fetch, "ntfy", `${this.base()}/v1/health`, { timeoutMs: 10_000 }, this.secrets());
      const healthy = expectOk("ntfy", res, this.secrets())?.healthy === true;
      const state = !healthy ? "down" : this.running && this.connected ? "up" : "degraded";
      return { platform: "ntfy", state, checkedAt: nowIso(), latencyMs: Date.now() - started, detail: `${new URL(this.base()).host} topic ${this.topic()}` };
    } catch (err) {
      return { platform: "ntfy", state: "down", checkedAt: nowIso(), latencyMs: Date.now() - started, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}
