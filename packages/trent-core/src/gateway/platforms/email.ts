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
import { checkSenderAuth } from "./email/auth-results.js";
import type { Security } from "./email/lineSocket.js";

export const EMAIL_DEFAULT_POLL_MS = 30_000;
const CURSOR_KEY = "email.uid";

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

  /** `gateway.email`: only an explicit `require_authenticated_from: false` turns the check off. */
  private senderAuthPolicy(): { required: boolean; authservId?: string } {
    const email = this.ctx.config.loadConfig().gateway?.email;
    return { required: email?.require_authenticated_from !== false, authservId: email?.authserv_id };
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
        if (policy.required) {
          const auth = checkSenderAuth({
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
