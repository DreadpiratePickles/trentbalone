/**
 * Email: IMAP polling for inbound (unseen mail, UID cursor persisted), SMTP submission
 * for outbound. Threads are Message-ID chains; there are no buttons, so an approval is
 * decided by an `APPROVE <id> <nonce>` reply, parsed by the gateway core.
 *
 * `From:` is whatever the sender typed, so by default a mail reaches the handler (and with it
 * pairing, routing and approvals) only when the receiving server's verdict authenticates the
 * From domain (`email/auth-results.ts`); `gateway.email.authserv_id` names that server so a
 * header the sender wrote is never read, and `gateway.email.require_authenticated_from: false`
 * turns the check off.
 */

import {
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
import { buttonsAsText, nowIso, TransportError } from "../transport/http.js";
import { SmtpClient } from "./email/smtp.js";
import { ImapClient, bareAddress, stripQuotedReply } from "./email/imap.js";
import { checkSenderAuth, type SenderAuthVerdict } from "./email/auth-results.js";
import type { Security } from "./email/lineSocket.js";

export const EMAIL_DEFAULT_POLL_MS = 30_000;
const CURSOR_KEY = "email.uid";

/**
 * [T-09] Why the sender-auth check refuses to trust the topmost Authentication-Results without a
 * pinned authserv-id: on an MTA that writes no header of its own, the sender's own header becomes
 * the topmost one, and there is no per-mail way to tell them apart. So rather than guess per mail,
 * the adapter fails closed at config time and names the one setting that resolves it.
 */
export const EMAIL_AUTHSERV_ID_UNSET_REASON =
  "gateway.email.authserv_id is not set; refusing inbound mail — set gateway.email.authserv_id to your mailbox provider's authserv-id (docs/gateway.md), or set gateway.email.require_authenticated_from: false to disable the check";

/** How inbound sender authentication is resolved from `gateway.email`, decided once per poll. */
export type SenderAuthPolicy =
  | { readonly mode: "off" }
  | { readonly mode: "pinned"; readonly authservId: string }
  | { readonly mode: "fail-closed"; readonly reason: string };

/**
 * `require_authenticated_from: false` turns the check off. Otherwise an authserv-id is required:
 * with one the pinned server's verdict decides, and without one the adapter fails closed rather
 * than trust a forgeable topmost header.
 */
export function resolveSenderAuthPolicy(email: { require_authenticated_from?: boolean; authserv_id?: string } | undefined): SenderAuthPolicy {
  if (email?.require_authenticated_from === false) return { mode: "off" };
  const authservId = email?.authserv_id?.trim() ?? "";
  if (authservId === "") return { mode: "fail-closed", reason: EMAIL_AUTHSERV_ID_UNSET_REASON };
  return { mode: "pinned", authservId };
}

export class EmailAdapter implements TransportAdapter {
  readonly platformId = "email";
  readonly name = "Email (IMAP inbound + SMTP outbound)";
  readonly apiVersion = "IMAP4rev1 (RFC 3501) / SMTP (RFC 5321, AUTH PLAIN, STARTTLS)";
  private messageHandler?: InboundHandler;
  private running = false;
  private timer?: ReturnType<typeof setTimeout>;
  private polling?: Promise<void>;

  constructor(private readonly ctx: AdapterContext) {}

  private setting(key: string): string | undefined {
    return readSetting(this.ctx, key);
  }

  private smtpOptions() {
    const host = this.setting("EMAIL_SMTP_HOST");
    if (!host) throw new TransportError("email: EMAIL_SMTP_HOST is not set", "email");
    const port = Number(this.setting("EMAIL_SMTP_PORT") ?? 587);
    const security = (this.setting("EMAIL_SMTP_SECURITY") as Security | undefined) ?? (port === 465 ? "tls" : "starttls");
    return { host, port, security, user: this.setting("EMAIL_SMTP_USER"), pass: this.setting("EMAIL_SMTP_PASS") };
  }

  private imapOptions() {
    const host = this.setting("EMAIL_IMAP_HOST");
    if (!host) throw new TransportError("email: EMAIL_IMAP_HOST is not set", "email");
    const port = Number(this.setting("EMAIL_IMAP_PORT") ?? 993);
    const security = (this.setting("EMAIL_IMAP_SECURITY") as Security | undefined) ?? (port === 993 ? "tls" : "starttls");
    const user = this.setting("EMAIL_IMAP_USER") ?? this.setting("EMAIL_SMTP_USER") ?? "";
    const pass = this.setting("EMAIL_IMAP_PASS") ?? this.setting("EMAIL_SMTP_PASS") ?? "";
    return { host, port, security, user, pass, mailbox: this.setting("EMAIL_IMAP_MAILBOX") ?? "INBOX" };
  }

  private from(): string {
    return this.setting("EMAIL_FROM") ?? this.setting("EMAIL_SMTP_USER") ?? "trent@localhost";
  }

  isConfigured(): boolean {
    return this.setting("EMAIL_SMTP_HOST") !== undefined && this.setting("EMAIL_SMTP_USER") !== undefined;
  }

  capabilities(): Capabilities {
    return { text: true, images: true, files: true, threads: true, reactions: false, buttons: false, typing: false };
  }

  onMessage(handler: InboundHandler): void { this.messageHandler = handler; }
  onCallback(_handler: CallbackHandler): void { /* decisions arrive as reply text */ }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    // [T-09] Say once, at startup, that inbound is failing closed for want of an authserv-id.
    const policy = resolveSenderAuthPolicy(this.ctx.config.loadConfig().gateway?.email);
    if (policy.mode === "fail-closed") (this.ctx.logger ?? SILENT_LOGGER).warn("email: inbound mail is refused until it is configured", { reason: policy.reason });
    if (!this.setting("EMAIL_IMAP_HOST")) return; // outbound-only configuration
    const interval = Number(this.setting("EMAIL_POLL_INTERVAL_MS") ?? EMAIL_DEFAULT_POLL_MS);
    const tick = async (): Promise<void> => {
      if (!this.running) return;
      this.polling = this.pollOnce().then(() => undefined).catch((err: unknown) => (this.ctx.logger ?? SILENT_LOGGER).warn("email poll error", { error: err instanceof Error ? err.message : String(err) }));
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

  /** `gateway.email` resolved to the sender-auth policy this poll enforces. */
  private senderAuthPolicy(): SenderAuthPolicy {
    return resolveSenderAuthPolicy(this.ctx.config.loadConfig().gateway?.email);
  }

  async pollOnce(): Promise<number> {
    // Read before anything is fetched or marked seen, so a config error loses no mail.
    const policy = this.senderAuthPolicy();
    const client = new ImapClient(this.imapOptions());
    await client.connect();
    try {
      const cursor = Number(this.ctx.store.snapshot().cursors[CURSOR_KEY] ?? 0) || undefined;
      const uids = await client.searchUnseen(cursor);
      for (const uid of uids) {
        const fetched = await client.fetch(uid);
        await client.markSeen(uid);
        this.ctx.store.mutate((s) => { s.cursors[CURSOR_KEY] = String(uid); });
        const h = fetched.headers;
        const sender = bareAddress(h.from);
        if (policy.mode !== "off") {
          // [T-09] A pinned server decides; an unset authserv-id fails closed rather than guess per mail.
          const auth: SenderAuthVerdict = policy.mode === "fail-closed"
            ? { ok: false, verdict: policy.reason }
            : checkSenderAuth({
                authservId: policy.authservId,
                fromAddress: sender,
                fromHeaderCount: fetched.headerValues.from?.length ?? 0,
                authenticationResults: fetched.headerValues["authentication-results"] ?? [],
                receivedSpf: fetched.headerValues["received-spf"] ?? [],
              });
          if (!auth.ok) {
            // Refused before pairing and routing: no code, no agent, no approval. Never the subject or body.
            (this.ctx.logger ?? SILENT_LOGGER).warn("email: refused mail whose From is not authenticated", { from: sender, verdict: auth.verdict });
            continue;
          }
        }
        const nameMatch = /^\s*"?([^"<]+?)"?\s*</.exec(h.from ?? "");
        const msg: InboundMessage = {
          id: h["message-id"] ?? `uid:${uid}`,
          platform: "email",
          channelId: sender,
          senderId: sender,
          senderName: nameMatch?.[1]?.trim(),
          content: stripQuotedReply(fetched.text),
          timestamp: h.date && !Number.isNaN(Date.parse(h.date)) ? new Date(h.date).toISOString() : nowIso(),
          scope: "dm",
          threadId: h["in-reply-to"] ?? h["message-id"],
          metadata: { subject: h.subject ?? "", references: h.references ?? "" },
        };
        await this.messageHandler?.(msg);
      }
      return uids.length;
    } finally {
      await client.logout();
    }
  }

  async send(message: OutboundMessage): Promise<SendReceipt> {
    const subjectRaw = typeof message.metadata?.subject === "string" ? message.metadata.subject : "Message from Trent";
    const subject = message.threadId && !/^re:/i.test(subjectRaw) ? `Re: ${subjectRaw}` : subjectRaw;
    const smtp = new SmtpClient(this.smtpOptions());
    const messageId = await smtp.send({
      from: this.from(),
      to: [message.channelId],
      subject,
      text: message.text + buttonsAsText(message.buttons),
      inReplyTo: message.threadId,
      references: message.threadId ? [message.threadId] : undefined,
      attachments: (message.attachments ?? []).filter((a) => typeof a.data !== "string").map((a) => ({ filename: a.filename, contentType: a.contentType, data: a.data as Uint8Array })),
    });
    return { platform: "email", messageId };
  }

  async health(): Promise<HealthStatus> {
    if (!this.isConfigured()) return { platform: "email", state: "stopped", checkedAt: nowIso(), detail: "not configured" };
    const started = Date.now();
    if (!this.setting("EMAIL_IMAP_HOST")) return { platform: "email", state: this.running ? "degraded" : "stopped", checkedAt: nowIso(), detail: "outbound only (no EMAIL_IMAP_HOST)" };
    try {
      const client = new ImapClient(this.imapOptions());
      await client.connect();
      await client.logout();
      return { platform: "email", state: this.running ? "up" : "degraded", checkedAt: nowIso(), latencyMs: Date.now() - started, detail: `imap ${this.imapOptions().host}` };
    } catch (err) {
      return { platform: "email", state: "down", checkedAt: nowIso(), latencyMs: Date.now() - started, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}
