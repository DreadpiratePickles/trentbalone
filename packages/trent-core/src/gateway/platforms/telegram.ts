/**
 * Telegram Bot API. Pinned to the Bot API 9.x method set: getMe, getUpdates (long-poll),
 * sendMessage, sendPhoto/sendDocument, answerCallbackQuery, sendChatAction, plus an
 * optional webhook receiver guarded by X-Telegram-Bot-Api-Secret-Token. `message_reaction`
 * updates arrive only when named in `allowed_updates` (getUpdates here; setWebhook likewise).
 * https://core.telegram.org/bots/api
 */

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
  type InboundReaction,
  type OutboundMessage,
  type ReactionHandler,
  type SendReceipt,
  type TransportAdapter,
  type WebhookRequest,
  type WebhookResponse,
} from "../transport/types.js";
import { toBlobPart, expectOk, httpRequest, nowIso, redact, TransportError } from "../transport/http.js";

interface TgUser { id: number; first_name?: string; username?: string }
interface TgChat { id: number; type: "private" | "group" | "supergroup" | "channel" }
/** A `voice` note or an `audio` file; the bytes are fetched with getFile. */
interface TgAudio { file_id: string; file_unique_id: string; duration: number; mime_type?: string; file_size?: number }
interface TgFile { file_id: string; file_size?: number; file_path?: string }
interface TgMessage { message_id: number; from?: TgUser; chat: TgChat; date: number; text?: string; caption?: string; message_thread_id?: number; voice?: TgAudio; audio?: TgAudio }
interface TgCallbackQuery { id: string; from: TgUser; message?: { message_id: number; chat: TgChat }; data?: string }
interface TgReactionType { type: "emoji" | "custom_emoji" | "paid"; emoji?: string; custom_emoji_id?: string }
/** A user changed their reaction on a message; `user` is absent when an anonymous chat reacted. */
interface TgMessageReaction { chat: TgChat; message_id: number; user?: TgUser; actor_chat?: TgChat; date: number; old_reaction: TgReactionType[]; new_reaction: TgReactionType[] }
interface TgUpdate { update_id: number; message?: TgMessage; callback_query?: TgCallbackQuery; message_reaction?: TgMessageReaction }
interface TgEnvelope<T> { ok: boolean; result?: T; description?: string }

export const TELEGRAM_API = "https://api.telegram.org";
export const TELEGRAM_POLL_TIMEOUT_S = 25;
export const TELEGRAM_ALLOWED_UPDATES = ["message", "callback_query", "message_reaction"] as const;

export class TelegramAdapter implements TransportAdapter {
  readonly platformId = "telegram";
  readonly name = "Telegram Bot API";
  readonly apiVersion = "Bot API 9.0";
  private readonly fetch: typeof fetch;
  private messageHandler?: InboundHandler;
  private callbackHandler?: CallbackHandler;
  private reactionHandler?: ReactionHandler;
  private running = false;
  private pollAbort?: AbortController;
  private pollLoop?: Promise<void>;
  private botUsername?: string;

  constructor(private readonly ctx: AdapterContext) {
    this.fetch = ctx.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private token(): string {
    const token = readSetting(this.ctx, "TELEGRAM_BOT_TOKEN");
    if (!token) throw new TransportError("telegram: TELEGRAM_BOT_TOKEN is not set", "telegram");
    return token;
  }

  private url(method: string): string {
    return `${baseUrlFor(this.ctx, "telegram", TELEGRAM_API)}/bot${this.token()}/${method}`;
  }

  private async call<T>(method: string, body: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<T> {
    const token = this.token();
    const res = await httpRequest<TgEnvelope<T>>(this.fetch, "telegram", this.url(method), { method: "POST", body, timeoutMs, signal }, [token]);
    const env = expectOk("telegram", res, [token]);
    if (!env.ok || env.result === undefined) {
      throw new TransportError(`telegram: ${method} failed: ${env.description ?? "no result"}`.split(token).join("[redacted]"), "telegram", res.status);
    }
    return env.result;
  }

  isConfigured(): boolean {
    return readSetting(this.ctx, "TELEGRAM_BOT_TOKEN") !== undefined;
  }

  capabilities(): Capabilities {
    return { text: true, images: true, files: true, threads: true, reactions: true, buttons: true, typing: true };
  }

  onMessage(handler: InboundHandler): void {
    this.messageHandler = handler;
  }

  onCallback(handler: CallbackHandler): void {
    this.callbackHandler = handler;
  }

  onReaction(handler: ReactionHandler): void {
    this.reactionHandler = handler;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const me = await this.call<TgUser>("getMe", {});
    this.botUsername = me.username;
    if (readSetting(this.ctx, "TELEGRAM_WEBHOOK_URL")) return; // inbound arrives via handleWebhook
    this.pollAbort = new AbortController();
    this.pollLoop = this.poll(this.pollAbort.signal);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.pollAbort?.abort();
    await this.pollLoop?.catch(() => undefined);
    this.pollLoop = undefined;
  }

  private async poll(signal: AbortSignal): Promise<void> {
    const key = "telegram.offset";
    let offset = Number(this.ctx.store.snapshot().cursors[key] ?? 0) || undefined;
    const logger = this.ctx.logger ?? SILENT_LOGGER;
    while (this.running && !signal.aborted) {
      try {
        const updates = await this.call<TgUpdate[]>(
          "getUpdates",
          { offset, timeout: TELEGRAM_POLL_TIMEOUT_S, allowed_updates: [...TELEGRAM_ALLOWED_UPDATES] },
          (TELEGRAM_POLL_TIMEOUT_S + 10) * 1000,
          signal,
        );
        for (const u of updates) {
          offset = u.update_id + 1;
          this.ctx.store.mutate((s) => { s.cursors[key] = String(offset); });
          await this.dispatch(u);
        }
      } catch (err) {
        if (signal.aborted) return;
        logger.warn("telegram poll error", { error: err instanceof Error ? err.message : String(err) });
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  private async dispatch(update: TgUpdate): Promise<void> {
    const m = update.message;
    const attachments = m ? this.audioAttachments(m) : undefined;
    if (m && (m.text !== undefined || m.caption !== undefined || attachments)) {
      const msg: InboundMessage = {
        id: String(m.message_id),
        platform: "telegram",
        channelId: String(m.chat.id),
        senderId: String(m.from?.id ?? m.chat.id),
        senderName: m.from?.username ?? m.from?.first_name,
        content: m.text ?? m.caption ?? "",
        timestamp: new Date(m.date * 1000).toISOString(),
        scope: m.chat.type === "private" ? "dm" : "group",
        threadId: m.message_thread_id !== undefined ? String(m.message_thread_id) : undefined,
        ...(attachments ? { attachments } : {}),
      };
      await this.messageHandler?.(msg);
    }
    if (update.callback_query) {
      const q = update.callback_query;
      const chat = q.message?.chat;
      const cb: ButtonCallback = {
        platform: "telegram",
        callbackId: q.id,
        senderId: String(q.from.id),
        channelId: String(chat?.id ?? q.from.id),
        scope: chat && chat.type !== "private" ? "group" : "dm",
        actionId: q.data ?? "",
        raw: q,
      };
      const ack = (await this.callbackHandler?.(cb)) ?? { ok: false, text: "No handler." };
      await this.call("answerCallbackQuery", { callback_query_id: q.id, text: ack.text });
    }
    if (update.message_reaction) await this.dispatchReaction(update.message_reaction);
  }

  /** [P2-3] A voice note or audio file, carried lazily: getFile and the download run only when the gateway opens it. */
  private audioAttachments(m: TgMessage): InboundAttachment[] | undefined {
    const file = m.voice ?? m.audio;
    if (!file) return undefined;
    const mime = file.mime_type ?? (m.voice ? "audio/ogg" : "audio/mpeg");
    return [{ kind: "audio", mime, durationSeconds: file.duration, ...(file.file_size !== undefined ? { sizeBytes: file.file_size } : {}), open: () => this.openFile(file.file_id) }];
  }

  /** getFile, then GET `<base>/file/bot<token>/<file_path>`. The token sits in that URL, so no error may carry it. */
  private async openFile(fileId: string): Promise<Response> {
    const file = await this.call<TgFile>("getFile", { file_id: fileId });
    if (!file.file_path || !/^[A-Za-z0-9_./-]+$/.test(file.file_path) || file.file_path.includes("..")) {
      throw new TransportError("telegram: getFile returned no usable file_path", "telegram");
    }
    const token = this.token();
    try {
      return await this.fetch(`${baseUrlFor(this.ctx, "telegram", TELEGRAM_API)}/file/bot${token}/${file.file_path}`, { signal: AbortSignal.timeout(INBOUND_DOWNLOAD_TIMEOUT_MS) });
    } catch (err) {
      throw new TransportError(`telegram: voice note download failed: ${redact(err instanceof Error ? err.message : String(err), [token])}`, "telegram");
    }
  }

  /** Each newly added unicode emoji is one reaction; removals, custom and paid reactions are not decisions. */
  private async dispatchReaction(r: TgMessageReaction): Promise<void> {
    if (!r.user) return;
    const before = new Set(r.old_reaction.filter((x) => x.type === "emoji").map((x) => x.emoji));
    for (const added of r.new_reaction) {
      if (added.type !== "emoji" || !added.emoji || before.has(added.emoji)) continue;
      const reaction: InboundReaction = {
        platform: "telegram",
        channelId: String(r.chat.id),
        messageId: String(r.message_id),
        emoji: added.emoji,
        senderId: String(r.user.id),
        scope: r.chat.type === "private" ? "dm" : "group",
      };
      await this.reactionHandler?.(reaction);
    }
  }

  async send(message: OutboundMessage): Promise<SendReceipt> {
    const chatId = Number.isFinite(Number(message.channelId)) ? Number(message.channelId) : message.channelId;
    const thread = message.threadId !== undefined ? { message_thread_id: Number(message.threadId) } : {};
    const replyMarkup = message.buttons && message.buttons.length > 0
      ? { reply_markup: { inline_keyboard: message.buttons.map((row) => row.map((b) => ({ text: b.label, callback_data: b.id }))) } }
      : {};
    let last: TgMessage | undefined;
    if (message.attachments && message.attachments.length > 0) {
      for (const a of message.attachments) {
        const isImage = a.contentType.startsWith("image/");
        const form = new FormData();
        form.set("chat_id", String(chatId));
        form.set("caption", message.text);
        if (typeof a.data === "string") form.set(isImage ? "photo" : "document", a.data);
        else form.set(isImage ? "photo" : "document", new Blob([toBlobPart(a.data)], { type: a.contentType }), a.filename);
        last = await this.call<TgMessage>(isImage ? "sendPhoto" : "sendDocument", form);
      }
      return { platform: "telegram", messageId: String(last?.message_id ?? "") };
    }
    last = await this.call<TgMessage>("sendMessage", { chat_id: chatId, text: message.text, ...thread, ...replyMarkup });
    return { platform: "telegram", messageId: String(last.message_id) };
  }

  async sendTyping(channelId: string): Promise<void> {
    await this.call("sendChatAction", { chat_id: Number(channelId), action: "typing" });
  }

  async health(): Promise<HealthStatus> {
    if (!this.isConfigured()) return { platform: "telegram", state: "stopped", checkedAt: nowIso(), detail: "not configured" };
    const started = Date.now();
    try {
      const me = await this.call<TgUser>("getMe", {}, 10_000);
      return { platform: "telegram", state: this.running ? "up" : "degraded", checkedAt: nowIso(), latencyMs: Date.now() - started, detail: `@${me.username ?? "?"}` };
    } catch (err) {
      return { platform: "telegram", state: "down", checkedAt: nowIso(), latencyMs: Date.now() - started, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  /** setWebhook target; inbound updates land here with the secret token header. */
  async handleWebhook(request: WebhookRequest): Promise<WebhookResponse> {
    const expected = readSetting(this.ctx, "TELEGRAM_WEBHOOK_SECRET");
    const got = request.headers["x-telegram-bot-api-secret-token"];
    if (!expected || got !== expected) return { status: 403, body: "forbidden" };
    let update: TgUpdate;
    try {
      update = JSON.parse(request.body) as TgUpdate;
    } catch {
      return { status: 400, body: "bad json" };
    }
    await this.dispatch(update);
    return { status: 200, body: "ok" };
  }

  get username(): string | undefined {
    return this.botUsername;
  }
}
