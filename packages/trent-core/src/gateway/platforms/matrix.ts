/**
 * [H4] Matrix over the client-server API, pinned to v1.11 (`/_matrix/client/v3`). A bot account's
 * access token (`MATRIX_ACCESS_TOKEN`) on `MATRIX_HOMESERVER_URL`. Endpoints, each from
 * https://spec.matrix.org/v1.11/client-server-api/:
 *   GET  /_matrix/client/v3/account/whoami                       #get_matrixclientv3accountwhoami
 *   GET  /_matrix/client/v3/sync?since=&timeout=                 #get_matrixclientv3sync
 *   POST /_matrix/client/v3/rooms/{roomId}/join                  #post_matrixclientv3roomsroomidjoin
 *   GET  /_matrix/client/v3/rooms/{roomId}/joined_members        #get_matrixclientv3roomsroomidjoined_members
 *   PUT  /_matrix/client/v3/rooms/{roomId}/send/{type}/{txnId}   #put_matrixclientv3roomsroomidsendeventtypetxnid
 *   GET  /_matrix/client/v1/media/download/{serverName}/{mediaId} #get_matrixclientv1mediadownloadservernamemediaid
 * Threads are `m.thread` relations (#threading); reactions are `m.reaction` events with an
 * `m.annotation` relation (#event-annotations-and-reactions). Matrix has no buttons, so an
 * approval card is text and a reaction on it decides. Encrypted rooms are not read.
 */

import crypto from "node:crypto";
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

export const MATRIX_SPEC_VERSION = "v1.11";
export const MATRIX_SYNC_TIMEOUT_MS = 30_000;
/** Where the since token lives in `GatewayStore.cursors`. */
export const MATRIX_SINCE_CURSOR = "matrix.since";
const CLIENT = "/_matrix/client/v3";

interface MxRelation { rel_type?: string; event_id?: string; key?: string; is_falling_back?: boolean; "m.in_reply_to"?: { event_id?: string } }
interface MxContent { msgtype?: string; body?: string; url?: string; info?: { mimetype?: string; size?: number; duration?: number }; "m.relates_to"?: MxRelation }
interface MxEvent { type: string; event_id: string; sender: string; origin_server_ts: number; content?: MxContent }
interface MxJoinedRoom { summary?: { "m.joined_member_count"?: number }; timeline?: { events?: MxEvent[] } }
interface MxSync { next_batch: string; rooms?: { join?: Record<string, MxJoinedRoom>; invite?: Record<string, unknown> } }

export class MatrixAdapter implements TransportAdapter {
  readonly platformId = "matrix";
  readonly name = "Matrix (client-server API)";
  readonly apiVersion = `Client-Server API ${MATRIX_SPEC_VERSION} (/_matrix/client/v3)`;
  private readonly fetch: typeof fetch;
  private messageHandler?: InboundHandler;
  private reactionHandler?: ReactionHandler;
  private running = false;
  private abort?: AbortController;
  private loop?: Promise<void>;
  private userId?: string;
  /** Joined member count per room, from the sync summary or `joined_members`; two or fewer is a DM. */
  private readonly roomSizes = new Map<string, number>();
  private readonly warnedEncrypted = new Set<string>();

  constructor(private readonly ctx: AdapterContext) {
    this.fetch = ctx.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private token(): string {
    const t = readSetting(this.ctx, "MATRIX_ACCESS_TOKEN");
    if (!t) throw new TransportError("matrix: MATRIX_ACCESS_TOKEN is not set", "matrix");
    return t;
  }

  private base(): string {
    const homeserver = readSetting(this.ctx, "MATRIX_HOMESERVER_URL");
    if (!homeserver && !this.ctx.baseUrls?.matrix) throw new TransportError("matrix: MATRIX_HOMESERVER_URL is not set", "matrix");
    return baseUrlFor(this.ctx, "matrix", homeserver ?? "");
  }

  private async api<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<T> {
    const token = this.token();
    const res = await httpRequest<T>(this.fetch, "matrix", `${this.base()}${path}`, { method, body, timeoutMs, signal, headers: { authorization: `Bearer ${token}` } }, [token]);
    return expectOk("matrix", res, [token]);
  }

  isConfigured(): boolean {
    return readSetting(this.ctx, "MATRIX_HOMESERVER_URL") !== undefined && readSetting(this.ctx, "MATRIX_ACCESS_TOKEN") !== undefined;
  }

  capabilities(): Capabilities {
    return { text: true, images: false, files: false, threads: true, reactions: true, buttons: false, typing: false };
  }

  onMessage(handler: InboundHandler): void { this.messageHandler = handler; }
  onCallback(_handler: CallbackHandler): void { /* no buttons: a card is decided by a reaction or an APPROVE reply */ }
  onReaction(handler: ReactionHandler): void { this.reactionHandler = handler; }

  async start(): Promise<void> {
    if (this.running) return;
    const me = await this.api<{ user_id: string }>("GET", `${CLIENT}/account/whoami`);
    this.userId = me.user_id;
    this.running = true;
    this.abort = new AbortController();
    this.loop = this.syncLoop(this.abort.signal);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abort?.abort();
    await this.loop?.catch(() => undefined);
    this.loop = undefined;
  }

  /**
   * Long-polls /sync. With no stored token the first sync is the room history (timeout 0), which
   * is skipped: only its token is kept. The token is persisted before a batch is dispatched, so a
   * restart resumes after it and never replays a message (at most once, like Telegram's offset).
   */
  private async syncLoop(signal: AbortSignal): Promise<void> {
    const logger = this.ctx.logger ?? SILENT_LOGGER;
    let since: string | undefined = this.ctx.store.snapshot().cursors[MATRIX_SINCE_CURSOR];
    while (this.running && !signal.aborted) {
      try {
        const initial: boolean = since === undefined;
        const query = new URLSearchParams({ timeout: String(initial ? 0 : MATRIX_SYNC_TIMEOUT_MS) });
        if (since !== undefined) query.set("since", since);
        const batch: MxSync = await this.api<MxSync>("GET", `${CLIENT}/sync?${query.toString()}`, undefined, MATRIX_SYNC_TIMEOUT_MS + 15_000, signal);
        if (typeof batch.next_batch !== "string" || batch.next_batch === "") throw new TransportError("matrix: sync returned no next_batch", "matrix");
        const persisted: string = batch.next_batch;
        since = persisted;
        this.ctx.store.mutate((s) => { s.cursors[MATRIX_SINCE_CURSOR] = persisted; });
        await this.joinInvites(Object.keys(batch.rooms?.invite ?? {}));
        const join: Record<string, MxJoinedRoom> = batch.rooms?.join ?? {};
        for (const [roomId, room] of Object.entries(join)) {
          const count = room.summary?.["m.joined_member_count"];
          if (typeof count === "number") this.roomSizes.set(roomId, count);
          if (initial) continue;
          for (const event of room.timeline?.events ?? []) await this.dispatch(roomId, event);
        }
      } catch (err) {
        if (signal.aborted) return;
        logger.warn("matrix sync error", { error: err instanceof Error ? err.message : String(err) });
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  /** An invite is how a DM with the bot begins; joining lets the sender reach the pairing gate. */
  private async joinInvites(roomIds: string[]): Promise<void> {
    for (const roomId of roomIds) {
      try {
        await this.api("POST", `${CLIENT}/rooms/${encodeURIComponent(roomId)}/join`, {});
      } catch (err) {
        (this.ctx.logger ?? SILENT_LOGGER).warn("matrix join failed", { room: roomId, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  private async scopeOf(roomId: string): Promise<Scope> {
    let size = this.roomSizes.get(roomId);
    if (size === undefined) {
      const members = await this.api<{ joined?: Record<string, unknown> }>("GET", `${CLIENT}/rooms/${encodeURIComponent(roomId)}/joined_members`);
      size = Object.keys(members.joined ?? {}).length;
      this.roomSizes.set(roomId, size);
    }
    return size <= 2 ? "dm" : "group";
  }

  private async dispatch(roomId: string, event: MxEvent): Promise<void> {
    if (!event.sender || event.sender === this.userId) return;
    const relation = event.content?.["m.relates_to"];
    if (event.type === "m.room.encrypted") {
      if (!this.warnedEncrypted.has(roomId)) (this.ctx.logger ?? SILENT_LOGGER).warn("matrix: encrypted room is not read", { room: roomId });
      this.warnedEncrypted.add(roomId);
      return;
    }
    if (event.type === "m.reaction") {
      if (relation?.rel_type !== "m.annotation" || !relation.event_id || !relation.key) return;
      await this.reactionHandler?.({ platform: "matrix", channelId: roomId, messageId: relation.event_id, emoji: relation.key, senderId: event.sender, scope: await this.scopeOf(roomId) });
      return;
    }
    if (event.type !== "m.room.message" || !event.content) return;
    const { msgtype } = event.content;
    // A notice is what bots send; the spec asks bots never to answer one. An edit is not a new message.
    if (msgtype === "m.notice" || relation?.rel_type === "m.replace") return;
    const attachments = msgtype === "m.audio" ? this.audioAttachments(event.content) : undefined;
    if (msgtype !== "m.text" && msgtype !== "m.emote" && !attachments) return;
    const msg: InboundMessage = {
      id: event.event_id,
      platform: "matrix",
      channelId: roomId,
      senderId: event.sender,
      content: attachments ? "" : event.content.body ?? "",
      timestamp: new Date(event.origin_server_ts).toISOString(),
      scope: await this.scopeOf(roomId),
      threadId: relation?.rel_type === "m.thread" ? relation.event_id : undefined,
      ...(attachments ? { attachments } : {}),
    };
    await this.messageHandler?.(msg);
  }

  /** [P2-3] An `m.audio` message (a voice note is one), downloaded through the homeserver's authenticated media only when opened. */
  private audioAttachments(content: MxContent): InboundAttachment[] | undefined {
    const mxc = /^mxc:\/\/([A-Za-z0-9.:-]+)\/([A-Za-z0-9_-]+)$/.exec(content.url ?? "");
    if (!mxc) return undefined;
    const [, serverName, mediaId] = mxc;
    const info = content.info ?? {};
    return [{
      kind: "audio",
      mime: info.mimetype ?? "audio/ogg",
      ...(info.duration !== undefined ? { durationSeconds: info.duration / 1000 } : {}),
      ...(info.size !== undefined ? { sizeBytes: info.size } : {}),
      open: () => this.openMedia(serverName!, mediaId!),
    }];
  }

  private async openMedia(serverName: string, mediaId: string): Promise<Response> {
    const token = this.token();
    try {
      return await this.fetch(`${this.base()}/_matrix/client/v1/media/download/${serverName}/${mediaId}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(INBOUND_DOWNLOAD_TIMEOUT_MS) });
    } catch (err) {
      throw new TransportError(`matrix: voice note download failed: ${redact(err instanceof Error ? err.message : String(err), [token])}`, "matrix");
    }
  }

  /** One PUT per event, with a fresh transaction id; the homeserver deduplicates a retried PUT on the same id. */
  private async sendEvent(roomId: string, type: string, content: Record<string, unknown>): Promise<string> {
    const txnId = `trent.${Date.now()}.${crypto.randomUUID()}`;
    const res = await this.api<{ event_id?: string }>("PUT", `${CLIENT}/rooms/${encodeURIComponent(roomId)}/send/${encodeURIComponent(type)}/${encodeURIComponent(txnId)}`, content);
    if (!res.event_id) throw new TransportError(`matrix: send ${type} returned no event_id`, "matrix");
    return res.event_id;
  }

  async send(message: OutboundMessage): Promise<SendReceipt> {
    const content: Record<string, unknown> = {
      msgtype: "m.text",
      body: message.text + buttonsAsText(message.buttons) + unsentAttachmentsAsText(message.attachments),
    };
    if (message.threadId) {
      content["m.relates_to"] = { rel_type: "m.thread", event_id: message.threadId, is_falling_back: true, "m.in_reply_to": { event_id: message.threadId } };
    }
    return { platform: "matrix", messageId: await this.sendEvent(message.channelId, "m.room.message", content) };
  }

  async react(roomId: string, eventId: string, key: string): Promise<void> {
    await this.sendEvent(roomId, "m.reaction", { "m.relates_to": { rel_type: "m.annotation", event_id: eventId, key } });
  }

  async health(): Promise<HealthStatus> {
    if (!this.isConfigured()) return { platform: "matrix", state: "stopped", checkedAt: nowIso(), detail: "not configured" };
    const started = Date.now();
    try {
      const me = await this.api<{ user_id: string }>("GET", `${CLIENT}/account/whoami`, undefined, 10_000);
      return { platform: "matrix", state: this.running ? "up" : "degraded", checkedAt: nowIso(), latencyMs: Date.now() - started, detail: me.user_id };
    } catch (err) {
      return { platform: "matrix", state: "down", checkedAt: nowIso(), latencyMs: Date.now() - started, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}
