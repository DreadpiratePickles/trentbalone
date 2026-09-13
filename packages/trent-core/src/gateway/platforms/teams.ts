/**
 * Microsoft Teams via Microsoft Graph v1.0 with application (client-credentials) auth.
 * Outbound: POST /chats/{id}/messages or /teams/{t}/channels/{c}/messages[/{m}/replies].
 * Inbound: polling of configured chats, and Graph change notifications over handleWebhook.
 * Interactive card submits need a Bot Framework bot, which app-only Graph does not
 * provide, so buttons render as text and decisions come back as a text reply.
 * https://learn.microsoft.com/graph/api/resources/chatmessage
 */

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
  type WebhookRequest,
  type WebhookResponse,
} from "../transport/types.js";
import { buttonsAsText, expectOk, httpRequest, nowIso, TransportError } from "../transport/http.js";

export const GRAPH_URL = "https://graph.microsoft.com";
export const GRAPH_VERSION = "v1.0";
export const LOGIN_URL = "https://login.microsoftonline.com";
export const TEAMS_DEFAULT_POLL_MS = 15_000;

interface GraphMessage { id: string; createdDateTime: string; from?: { user?: { id: string; displayName?: string } | null; application?: unknown } | null; body: { contentType: string; content: string }; chatId?: string; channelIdentity?: { teamId: string; channelId: string } }

export class TeamsAdapter implements TransportAdapter {
  readonly platformId = "teams";
  readonly name = "Microsoft Teams (Graph)";
  readonly apiVersion = GRAPH_VERSION;
  private readonly fetch: typeof fetch;
  private messageHandler?: InboundHandler;
  private running = false;
  private timer?: ReturnType<typeof setTimeout>;
  private polling?: Promise<void>;
  private token?: { value: string; expiresAt: number };

  constructor(private readonly ctx: AdapterContext) {
    this.fetch = ctx.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private secrets(): Array<string | undefined> {
    return [readSetting(this.ctx, "TEAMS_CLIENT_SECRET"), this.token?.value];
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const tenant = readSetting(this.ctx, "TEAMS_TENANT_ID");
    const clientId = readSetting(this.ctx, "TEAMS_CLIENT_ID");
    const secret = readSetting(this.ctx, "TEAMS_CLIENT_SECRET");
    if (!tenant || !clientId || !secret) throw new TransportError("teams: TEAMS_TENANT_ID, TEAMS_CLIENT_ID and TEAMS_CLIENT_SECRET are required", "teams");
    const form = new URLSearchParams({ client_id: clientId, client_secret: secret, scope: `${GRAPH_URL}/.default`, grant_type: "client_credentials" });
    const res = await httpRequest<{ access_token: string; expires_in: number }>(this.fetch, "teams", `${baseUrlFor(this.ctx, "teamsLogin", LOGIN_URL)}/${tenant}/oauth2/v2.0/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString(),
    }, [secret]);
    const body = expectOk("teams", res, [secret]);
    this.token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return body.access_token;
  }

  private async graph<T>(method: "GET" | "POST", path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    const token = await this.accessToken();
    const res = await httpRequest<T>(this.fetch, "teams", `${baseUrlFor(this.ctx, "teams", GRAPH_URL)}/${GRAPH_VERSION}${path}`, {
      method, body, timeoutMs, headers: { authorization: `Bearer ${token}` },
    }, this.secrets());
    return expectOk("teams", res, this.secrets());
  }

  isConfigured(): boolean {
    return ["TEAMS_TENANT_ID", "TEAMS_CLIENT_ID", "TEAMS_CLIENT_SECRET"].every((k) => readSetting(this.ctx, k) !== undefined);
  }

  capabilities(): Capabilities {
    return { text: true, images: false, files: false, threads: true, reactions: false, buttons: false, typing: false };
  }

  onMessage(handler: InboundHandler): void { this.messageHandler = handler; }
  onCallback(_handler: CallbackHandler): void { /* decisions arrive as text */ }

  private chatIds(): string[] {
    return (readSetting(this.ctx, "TEAMS_CHAT_IDS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    if (this.chatIds().length === 0) return;
    const interval = Number(readSetting(this.ctx, "TEAMS_POLL_INTERVAL_MS") ?? TEAMS_DEFAULT_POLL_MS);
    const tick = async (): Promise<void> => {
      if (!this.running) return;
      this.polling = this.pollOnce().then(() => undefined).catch((err: unknown) => (this.ctx.logger ?? SILENT_LOGGER).warn("teams poll error", { error: err instanceof Error ? err.message : String(err) }));
      await this.polling;
      if (this.running) this.timer = setTimeout(() => void tick(), interval);
    };
    void tick();
  }

  async stop(): Promise<void> {
    this.running = false;
    clearTimeout(this.timer);
    await this.polling;
  }

  async pollOnce(): Promise<number> {
    let delivered = 0;
    for (const chatId of this.chatIds()) {
      const key = `teams.cursor.${chatId}`;
      const cursor = this.ctx.store.snapshot().cursors[key] ?? "";
      const page = await this.graph<{ value: GraphMessage[] }>("GET", `/chats/${encodeURIComponent(chatId)}/messages?$top=50`);
      const fresh = page.value.filter((m) => m.createdDateTime > cursor).sort((a, b) => a.createdDateTime.localeCompare(b.createdDateTime));
      for (const m of fresh) {
        this.ctx.store.mutate((s) => { s.cursors[key] = m.createdDateTime; });
        if (await this.dispatch(m, `chat:${chatId}`)) delivered += 1;
      }
    }
    return delivered;
  }

  private async dispatch(m: GraphMessage, channelId: string): Promise<boolean> {
    const user = m.from?.user;
    if (!user) return false; // application/bot/system messages
    const msg: InboundMessage = {
      id: m.id, platform: "teams", channelId, senderId: user.id, senderName: user.displayName ?? undefined,
      content: stripHtml(m.body.content), timestamp: new Date(m.createdDateTime).toISOString(),
      scope: "group", threadId: m.channelIdentity ? m.id : undefined,
    };
    await this.messageHandler?.(msg);
    return true;
  }

  async send(message: OutboundMessage): Promise<SendReceipt> {
    const html = escapeHtml(message.text + buttonsAsText(message.buttons)).replace(/\n/g, "<br>");
    const target = parseChannel(message.channelId);
    let path: string;
    if (target.kind === "chat") path = `/chats/${encodeURIComponent(target.chatId)}/messages`;
    else path = `/teams/${target.teamId}/channels/${target.channelId}/messages${message.threadId ? `/${message.threadId}/replies` : ""}`;
    const created = await this.graph<{ id: string }>("POST", path, { body: { contentType: "html", content: html } });
    return { platform: "teams", messageId: created.id };
  }

  async health(): Promise<HealthStatus> {
    if (!this.isConfigured()) return { platform: "teams", state: "stopped", checkedAt: nowIso(), detail: "not configured" };
    const started = Date.now();
    try {
      await this.accessToken();
      return { platform: "teams", state: this.running ? "up" : "degraded", checkedAt: nowIso(), latencyMs: Date.now() - started, detail: `token ok, ${this.chatIds().length} chat(s) polled` };
    } catch (err) {
      return { platform: "teams", state: "down", checkedAt: nowIso(), latencyMs: Date.now() - started, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Graph change notifications: validation handshake, then notifications gated on clientState. */
  async handleWebhook(request: WebhookRequest): Promise<WebhookResponse> {
    const validation = new URL(request.url, "http://localhost").searchParams.get("validationToken");
    if (validation !== null) return { status: 200, body: validation, headers: { "content-type": "text/plain" } };
    const expected = readSetting(this.ctx, "TEAMS_WEBHOOK_CLIENT_STATE");
    let payload: { value?: Array<{ clientState?: string; resource?: string }> };
    try {
      payload = JSON.parse(request.body || "{}") as typeof payload;
    } catch {
      return { status: 202, body: "" };
    }
    for (const n of payload.value ?? []) {
      if (!expected || n.clientState !== expected || !n.resource) continue;
      const m = await this.graph<GraphMessage>("GET", `/${n.resource.replace(/^\//, "")}`).catch(() => undefined);
      if (m) await this.dispatch(m, m.chatId ? `chat:${m.chatId}` : `team:${m.channelIdentity?.teamId}/${m.channelIdentity?.channelId}`);
    }
    return { status: 202, body: "" };
  }
}

function parseChannel(id: string): { kind: "chat"; chatId: string } | { kind: "channel"; teamId: string; channelId: string } {
  if (id.startsWith("team:")) {
    const [teamId, channelId] = id.slice(5).split("/");
    return { kind: "channel", teamId, channelId };
  }
  return { kind: "chat", chatId: id.replace(/^chat:/, "") };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function stripHtml(html: string): string {
  return html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim();
}
