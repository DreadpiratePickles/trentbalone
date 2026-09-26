/**
 * [H4] Mattermost over API v4 with a bot account's access token (`MATTERMOST_BOT_TOKEN`) on
 * `MATTERMOST_URL`. Endpoints, each from https://api.mattermost.com/:
 *   GET  /api/v4/users/me              #tag/users/operation/GetUser (user_id "me")
 *   POST /api/v4/posts                 #tag/posts/operation/CreatePost (root_id replies in a thread)
 *   POST /api/v4/reactions             #tag/reactions/operation/SaveReaction
 *   GET  /api/v4/channels/{channel_id} #tag/channels/operation/GetChannel (a reaction's scope)
 *   GET  /api/v4/files/{file_id}       #tag/files/operation/GetFile (a voice note, after pairing)
 *   WS   /api/v4/websocket             #tag/WebSocket: `authentication_challenge`, then `hello`,
 *                                       `posted` and `reaction_added` events.
 * Interactive-message buttons are not offered: Mattermost posts a button press to an integration
 * URL unsigned, so anyone who can reach that URL could press as the admin. A card is text, and a
 * reaction on it (the `+1` / `white_check_mark` / `-1` / `x` names) decides it.
 */

import {
  baseUrlFor,
  INBOUND_DOWNLOAD_TIMEOUT_MS,
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
  type ReactionHandler,
  type Scope,
  type SendReceipt,
  type TransportAdapter,
} from "../transport/types.js";
import { buttonsAsText, expectOk, httpRequest, nowIso, redact, TransportError, unsentAttachmentsAsText } from "../transport/http.js";

export const MATTERMOST_API_VERSION = "v4";
/** `<create_at>:<post id>` of the last post handled, in `GatewayStore.cursors`. */
export const MATTERMOST_LAST_CURSOR = "mattermost.last";
export const MATTERMOST_HELLO_TIMEOUT_MS = 15_000;

interface MmFile { id: string; name?: string; mime_type?: string; size?: number }
interface MmPost { id: string; create_at: number; user_id: string; channel_id: string; root_id?: string; message?: string; type?: string; metadata?: { files?: MmFile[] } }
interface MmReaction { user_id: string; post_id: string; emoji_name: string; channel_id?: string }
interface MmFrame { event?: string; data?: { post?: string; reaction?: string; channel_type?: string; sender_name?: string }; broadcast?: { channel_id?: string }; status?: string; seq_reply?: number }

export class MattermostAdapter implements TransportAdapter {
  readonly platformId = "mattermost";
  readonly name = "Mattermost (API v4 + WebSocket)";
  readonly apiVersion = `API ${MATTERMOST_API_VERSION}`;
  private readonly fetch: typeof fetch;
  private messageHandler?: InboundHandler;
  private reactionHandler?: ReactionHandler;
  private running = false;
  private ws?: WebSocket;
  private userId?: string;
  private username?: string;
  private hello?: () => void;
  /** `D` is a direct message; `G` (group DM), `O` (public) and `P` (private) are groups. */
  private readonly channelTypes = new Map<string, string>();

  constructor(private readonly ctx: AdapterContext) {
    this.fetch = ctx.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private token(): string {
    const t = readSetting(this.ctx, "MATTERMOST_BOT_TOKEN");
    if (!t) throw new TransportError("mattermost: MATTERMOST_BOT_TOKEN is not set", "mattermost");
    return t;
  }

  private base(): string {
    const url = readSetting(this.ctx, "MATTERMOST_URL");
    if (!url && !this.ctx.baseUrls?.mattermost) throw new TransportError("mattermost: MATTERMOST_URL is not set", "mattermost");
    return baseUrlFor(this.ctx, "mattermost", url ?? "");
  }

  private async api<T>(method: "GET" | "POST", path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    const token = this.token();
    const res = await httpRequest<T>(this.fetch, "mattermost", `${this.base()}/api/v4${path}`, { method, body, timeoutMs, headers: { authorization: `Bearer ${token}` } }, [token]);
    return expectOk("mattermost", res, [token]);
  }

  isConfigured(): boolean {
    return readSetting(this.ctx, "MATTERMOST_URL") !== undefined && readSetting(this.ctx, "MATTERMOST_BOT_TOKEN") !== undefined;
  }

  capabilities(): Capabilities {
    return { text: true, images: false, files: false, threads: true, reactions: true, buttons: false, typing: false };
  }

  onMessage(handler: InboundHandler): void { this.messageHandler = handler; }
  onCallback(_handler: CallbackHandler): void { /* no buttons: see the header */ }
  onReaction(handler: ReactionHandler): void { this.reactionHandler = handler; }

  private async me(): Promise<string> {
    if (this.userId) return this.userId;
    const me = await this.api<{ id: string; username?: string }>("GET", "/users/me");
    this.userId = me.id;
    this.username = me.username;
    return me.id;
  }

  async start(): Promise<void> {
    if (this.running) return;
    await this.me();
    this.running = true;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.running = false;
    const ws = this.ws;
    this.ws = undefined;
    ws?.close();
  }

  private socketUrl(): string {
    const url = new URL(`${this.base()}/api/v4/websocket`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  }

  /** Opens the socket, answers the challenge with the token, and resolves on the server's `hello`. */
  private async connect(): Promise<void> {
    const logger = this.ctx.logger ?? SILENT_LOGGER;
    const token = this.token();
    const ws = new WebSocket(this.socketUrl());
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      void this.onFrame(String(ev.data)).catch((err: unknown) => logger.warn("mattermost frame error", { error: redact(String(err), [token]) }));
    });
    ws.addEventListener("close", () => {
      if (this.running && this.ws === ws) setTimeout(() => { if (this.running && this.ws === ws) void this.connect().catch(() => undefined); }, 2000);
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new TransportError("mattermost: no hello from the websocket", "mattermost")), MATTERMOST_HELLO_TIMEOUT_MS);
      this.hello = () => { clearTimeout(timer); resolve(); };
      ws.addEventListener("open", () => ws.send(JSON.stringify({ seq: 1, action: "authentication_challenge", data: { token } })), { once: true });
      const fail = () => { clearTimeout(timer); reject(new TransportError("mattermost: websocket closed before hello", "mattermost")); };
      ws.addEventListener("error", fail, { once: true });
      ws.addEventListener("close", fail, { once: true });
    });
  }

  private async onFrame(text: string): Promise<void> {
    const frame = JSON.parse(text) as MmFrame;
    if (frame.seq_reply === 1 && frame.status !== undefined && frame.status !== "OK") {
      this.ws?.close(); // the challenge was refused
      return;
    }
    if (frame.event === "hello") { this.hello?.(); return; }
    if (frame.event === "posted" && frame.data?.post) await this.onPosted(JSON.parse(frame.data.post) as MmPost, frame.data);
    if (frame.event === "reaction_added" && frame.data?.reaction) await this.onReacted(JSON.parse(frame.data.reaction) as MmReaction, frame.broadcast?.channel_id);
  }

  /**
   * The watermark check and its update run before any await, so posts are judged in the order the
   * socket delivered them. A post older than the persisted `<create_at>:<id>`, or that very post, has
   * been handled (a resumed socket, or the same post sent again) and is dropped; the watermark is in
   * the gateway store, so it survives a restart.
   */
  private async onPosted(post: MmPost, data: NonNullable<MmFrame["data"]>): Promise<void> {
    if (!post.id || post.user_id === this.userId || (post.type ?? "") !== "") return; // own posts and system messages
    const last = this.ctx.store.snapshot().cursors[MATTERMOST_LAST_CURSOR];
    const [lastAt, lastId] = last ? [Number(last.slice(0, last.indexOf(":"))), last.slice(last.indexOf(":") + 1)] : [Number.NEGATIVE_INFINITY, ""];
    if (post.create_at < lastAt || post.id === lastId) return;
    this.ctx.store.mutate((s) => { s.cursors[MATTERMOST_LAST_CURSOR] = `${post.create_at}:${post.id}`; });
    if (data.channel_type) this.channelTypes.set(post.channel_id, data.channel_type);
    const attachments = this.audioAttachments(post.metadata?.files);
    if (!post.message && !attachments) return;
    const msg: InboundMessage = {
      id: post.id,
      platform: "mattermost",
      channelId: post.channel_id,
      senderId: post.user_id,
      senderName: data.sender_name?.replace(/^@/, ""),
      content: post.message ?? "",
      timestamp: new Date(post.create_at).toISOString(),
      scope: data.channel_type === "D" ? "dm" : "group",
      threadId: post.root_id ? post.root_id : undefined,
      ...(attachments ? { attachments } : {}),
    };
    await this.messageHandler?.(msg);
  }

  private async onReacted(reaction: MmReaction, broadcastChannel: string | undefined): Promise<void> {
    const channelId = reaction.channel_id ?? broadcastChannel;
    if (!channelId || !reaction.post_id || reaction.user_id === this.userId) return;
    await this.reactionHandler?.({ platform: "mattermost", channelId, messageId: reaction.post_id, emoji: reaction.emoji_name, senderId: reaction.user_id, scope: await this.scopeOf(channelId) });
  }

  private async scopeOf(channelId: string): Promise<Scope> {
    let type = this.channelTypes.get(channelId);
    if (type === undefined) {
      type = (await this.api<{ type?: string }>("GET", `/channels/${encodeURIComponent(channelId)}`)).type ?? "O";
      this.channelTypes.set(channelId, type);
    }
    return type === "D" ? "dm" : "group";
  }

  /** [P2-3] Audio files on a post, fetched with GetFile through this server only when the gateway opens one. */
  private audioAttachments(files: MmFile[] | undefined): InboundAttachment[] | undefined {
    const audio = (files ?? []).filter((f) => /^[A-Za-z0-9]+$/.test(f.id) && f.mime_type?.toLowerCase().startsWith("audio/"));
    if (audio.length === 0) return undefined;
    return audio.map((f): InboundAttachment => ({ kind: "audio", mime: f.mime_type ?? "audio/mp4", ...(f.size !== undefined ? { sizeBytes: f.size } : {}), open: () => this.openFile(f.id) }));
  }

  private async openFile(fileId: string): Promise<Response> {
    const token = this.token();
    try {
      return await this.fetch(`${this.base()}/api/v4/files/${fileId}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(INBOUND_DOWNLOAD_TIMEOUT_MS) });
    } catch (err) {
      throw new TransportError(`mattermost: voice note download failed: ${redact(err instanceof Error ? err.message : String(err), [token])}`, "mattermost");
    }
  }

  async send(message: OutboundMessage): Promise<SendReceipt> {
    const body: Record<string, unknown> = {
      channel_id: message.channelId,
      message: message.text + buttonsAsText(message.buttons) + unsentAttachmentsAsText(message.attachments),
    };
    if (message.threadId) body.root_id = message.threadId;
    const created = await this.api<{ id?: string }>("POST", "/posts", body);
    if (!created.id) throw new TransportError("mattermost: CreatePost returned no id", "mattermost");
    return { platform: "mattermost", messageId: created.id };
  }

  async react(postId: string, emojiName: string): Promise<void> {
    await this.api("POST", "/reactions", { user_id: await this.me(), post_id: postId, emoji_name: emojiName });
  }

  async health(): Promise<HealthStatus> {
    if (!this.isConfigured()) return { platform: "mattermost", state: "stopped", checkedAt: nowIso(), detail: "not configured" };
    const started = Date.now();
    try {
      const me = await this.api<{ username?: string }>("GET", "/users/me", undefined, 10_000);
      const socketUp = this.ws?.readyState === WebSocket.OPEN;
      return { platform: "mattermost", state: this.running && socketUp ? "up" : "degraded", checkedAt: nowIso(), latencyMs: Date.now() - started, detail: `@${me.username ?? this.username ?? "?"}` };
    } catch (err) {
      return { platform: "mattermost", state: "down", checkedAt: nowIso(), latencyMs: Date.now() - started, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}
