/**
 * Signal via signal-cli's HTTP daemon (`signal-cli daemon --http`): JSON-RPC 2.0 on
 * POST /api/v1/rpc for outbound, server-sent events on GET /api/v1/events for inbound.
 * https://github.com/AsamK/signal-cli/blob/master/man/signal-cli-jsonrpc.5.adoc
 */

import crypto from "node:crypto";
import {
  baseUrlFor,
  readSetting,
  SILENT_LOGGER,
  type AdapterContext,
  type CallbackHandler,
  type Capabilities,
  type HealthStatus,
  type InboundHandler,
  type InboundMessage,
  type OutboundMessage,
  type SendReceipt,
  type TransportAdapter,
} from "../transport/types.js";
import { buttonsAsText, expectOk, httpRequest, nowIso, TransportError } from "../transport/http.js";

export const SIGNAL_CLI_DEFAULT_URL = "http://127.0.0.1:8080";
export const SIGNAL_JSONRPC_VERSION = "2.0";
const GROUP_PREFIX = "group:";

interface RpcResponse<T> { jsonrpc: string; id: string; result?: T; error?: { code: number; message: string } }
interface Envelope { source?: string; sourceNumber?: string; sourceUuid?: string; sourceName?: string; timestamp: number; dataMessage?: { timestamp: number; message?: string | null; groupInfo?: { groupId: string } } }
interface ReceiveEvent { method?: string; params?: { envelope?: Envelope; account?: string } }

export class SignalAdapter implements TransportAdapter {
  readonly platformId = "signal";
  readonly name = "Signal (signal-cli JSON-RPC)";
  readonly apiVersion = `signal-cli JSON-RPC ${SIGNAL_JSONRPC_VERSION} (daemon 0.13.x)`;
  private readonly fetch: typeof fetch;
  private messageHandler?: InboundHandler;
  private running = false;
  private abort?: AbortController;
  private stream?: Promise<void>;

  constructor(private readonly ctx: AdapterContext) {
    this.fetch = ctx.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private account(): string {
    const n = readSetting(this.ctx, "SIGNAL_NUMBER");
    if (!n) throw new TransportError("signal: SIGNAL_NUMBER is not set", "signal");
    return n;
  }

  private base(): string {
    return baseUrlFor(this.ctx, "signal", readSetting(this.ctx, "SIGNAL_CLI_URL") ?? SIGNAL_CLI_DEFAULT_URL);
  }

  private async rpc<T>(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    const id = crypto.randomUUID();
    const res = await httpRequest<RpcResponse<T>>(this.fetch, "signal", `${this.base()}/api/v1/rpc`, { method: "POST", body: { jsonrpc: SIGNAL_JSONRPC_VERSION, id, method, params }, timeoutMs });
    const body = expectOk("signal", res);
    if (body.error) throw new TransportError(`signal: ${method} failed: ${body.error.message} (${body.error.code})`, "signal", res.status);
    return body.result as T;
  }

  isConfigured(): boolean {
    return readSetting(this.ctx, "SIGNAL_NUMBER") !== undefined;
  }

  capabilities(): Capabilities {
    return { text: true, images: true, files: true, threads: false, reactions: true, buttons: false, typing: true };
  }

  onMessage(handler: InboundHandler): void { this.messageHandler = handler; }
  onCallback(_handler: CallbackHandler): void { /* no buttons; decisions arrive as text and are parsed by the gateway */ }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    this.stream = this.consumeEvents(this.abort.signal);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abort?.abort();
    await this.stream?.catch(() => undefined);
  }

  private async consumeEvents(signal: AbortSignal): Promise<void> {
    const logger = this.ctx.logger ?? SILENT_LOGGER;
    while (this.running && !signal.aborted) {
      try {
        const res = await this.fetch(`${this.base()}/api/v1/events?account=${encodeURIComponent(this.account())}`, { headers: { accept: "text/event-stream" }, signal });
        if (!res.ok || !res.body) throw new TransportError(`signal: events HTTP ${res.status}`, "signal", res.status);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const chunk = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            await this.onSse(chunk);
          }
        }
      } catch (err) {
        if (signal.aborted) return;
        logger.warn("signal event stream error", { error: err instanceof Error ? err.message : String(err) });
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  private async onSse(chunk: string): Promise<void> {
    const data = chunk.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
    if (!data) return;
    let ev: ReceiveEvent;
    try {
      ev = JSON.parse(data) as ReceiveEvent;
    } catch {
      return;
    }
    const env = ev.params?.envelope;
    const dm = env?.dataMessage;
    if (!env || !dm || dm.message === undefined || dm.message === null) return; // receipts, typing, sync
    const sender = env.sourceNumber ?? env.source ?? env.sourceUuid ?? "";
    const group = dm.groupInfo?.groupId;
    const msg: InboundMessage = {
      id: String(dm.timestamp ?? env.timestamp),
      platform: "signal",
      channelId: group ? `${GROUP_PREFIX}${group}` : sender,
      senderId: sender,
      senderName: env.sourceName,
      content: dm.message,
      timestamp: new Date(env.timestamp).toISOString(),
      scope: group ? "group" : "dm",
    };
    await this.messageHandler?.(msg);
  }

  private target(channelId: string): Record<string, unknown> {
    return channelId.startsWith(GROUP_PREFIX) ? { groupId: channelId.slice(GROUP_PREFIX.length) } : { recipient: [channelId] };
  }

  async send(message: OutboundMessage): Promise<SendReceipt> {
    const attachments = (message.attachments ?? []).map((a) =>
      typeof a.data === "string" ? a.data : `data:${a.contentType};filename=${a.filename};base64,${Buffer.from(a.data).toString("base64")}`,
    );
    const params: Record<string, unknown> = { account: this.account(), ...this.target(message.channelId), message: message.text + buttonsAsText(message.buttons) };
    if (attachments.length > 0) params.attachments = attachments;
    const result = await this.rpc<{ timestamp: number }>("send", params);
    return { platform: "signal", messageId: String(result.timestamp) };
  }

  async react(channelId: string, targetAuthor: string, targetTimestamp: number, emoji: string): Promise<void> {
    await this.rpc("sendReaction", { account: this.account(), ...this.target(channelId), emoji, targetAuthor, targetTimestamp });
  }

  async sendTyping(channelId: string): Promise<void> {
    await this.rpc("sendTyping", { account: this.account(), ...this.target(channelId) });
  }

  async health(): Promise<HealthStatus> {
    if (!this.isConfigured()) return { platform: "signal", state: "stopped", checkedAt: nowIso(), detail: "not configured" };
    const started = Date.now();
    try {
      const v = await this.rpc<{ version: string }>("version", {}, 10_000);
      return { platform: "signal", state: this.running ? "up" : "degraded", checkedAt: nowIso(), latencyMs: Date.now() - started, detail: `signal-cli ${v.version}` };
    } catch (err) {
      return { platform: "signal", state: "down", checkedAt: nowIso(), latencyMs: Date.now() - started, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}
