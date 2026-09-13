/**
 * Minimal SMTP submission client (RFC 5321 + AUTH PLAIN, RFC 4954; STARTTLS, RFC 3207)
 * and an RFC 5322 / MIME message builder. No dependency; every byte on the wire is ours.
 */

import crypto from "node:crypto";
import { LineSocket, type Security } from "./lineSocket.js";

export interface SmtpOptions {
  host: string;
  port: number;
  security: Security;
  user?: string;
  pass?: string;
  timeoutMs?: number;
}

export interface MailAttachment { filename: string; contentType: string; data: Uint8Array }

export interface Mail {
  from: string;
  to: string[];
  subject: string;
  text: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: MailAttachment[];
  date?: Date;
}

export function makeMessageId(domain: string): string {
  return `<${crypto.randomUUID()}@${domain}>`;
}

function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function wrap76(b64: string): string {
  return b64.replace(/(.{76})/g, "$1\r\n");
}

/** Builds the exact bytes sent after DATA (before dot-stuffing). */
export function buildMime(mail: Mail): string {
  const date = (mail.date ?? new Date()).toUTCString().replace("GMT", "+0000");
  const headers = [
    `From: ${mail.from}`,
    `To: ${mail.to.join(", ")}`,
    `Subject: ${encodeHeader(mail.subject)}`,
    `Date: ${date}`,
    `Message-ID: ${mail.messageId ?? makeMessageId(mail.from.split("@")[1]?.replace(/>$/, "") ?? "trent.local")}`,
    "MIME-Version: 1.0",
  ];
  if (mail.inReplyTo) headers.push(`In-Reply-To: ${mail.inReplyTo}`);
  if (mail.references && mail.references.length > 0) headers.push(`References: ${mail.references.join(" ")}`);
  const textPart = ["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", wrap76(Buffer.from(mail.text, "utf8").toString("base64"))].join("\r\n");
  if (!mail.attachments || mail.attachments.length === 0) {
    return [...headers, textPart].join("\r\n") + "\r\n";
  }
  const boundary = `=_trent_${crypto.randomBytes(8).toString("hex")}`;
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  const parts = [textPart, ...mail.attachments.map((a) =>
    [`Content-Type: ${a.contentType}; name="${a.filename}"`, "Content-Transfer-Encoding: base64", `Content-Disposition: attachment; filename="${a.filename}"`, "", wrap76(Buffer.from(a.data).toString("base64"))].join("\r\n"),
  )];
  return [...headers, "", ...parts.map((p) => `--${boundary}\r\n${p}`), `--${boundary}--`, ""].join("\r\n");
}

export class SmtpClient {
  readonly transcript: string[] = [];

  constructor(private readonly options: SmtpOptions) {}

  private async expect(socket: LineSocket, codes: number[]): Promise<string[]> {
    const lines: string[] = [];
    for (;;) {
      const line = await socket.readLine();
      lines.push(line);
      const code = Number(line.slice(0, 3));
      if (line[3] === "-") continue;
      if (!codes.includes(code)) throw new Error(`smtp: expected ${codes.join("/")}, got ${line.slice(0, 3)}`);
      return lines;
    }
  }

  private async command(socket: LineSocket, cmd: string, codes: number[], log = cmd): Promise<string[]> {
    this.transcript.push(log);
    socket.writeLine(cmd);
    return this.expect(socket, codes);
  }

  async send(mail: Mail): Promise<string> {
    const { host, port, security } = this.options;
    const socket = new LineSocket(this.options.timeoutMs);
    await socket.connect(host, port, security);
    try {
      await this.expect(socket, [220]);
      let ehlo = await this.command(socket, "EHLO trent.local", [250]);
      if (security === "starttls") {
        if (!ehlo.some((l) => /STARTTLS/i.test(l))) throw new Error("smtp: server does not offer STARTTLS");
        await this.command(socket, "STARTTLS", [220]);
        await socket.upgradeTls(host);
        ehlo = await this.command(socket, "EHLO trent.local", [250]);
      }
      if (this.options.user !== undefined) {
        if (!ehlo.some((l) => /AUTH .*PLAIN/i.test(l))) throw new Error("smtp: server does not offer AUTH PLAIN");
        const cred = Buffer.from(`\0${this.options.user}\0${this.options.pass ?? ""}`, "utf8").toString("base64");
        await this.command(socket, `AUTH PLAIN ${cred}`, [235], "AUTH PLAIN [redacted]");
      }
      const messageId = mail.messageId ?? makeMessageId(mail.from.replace(/.*@/, "").replace(/>$/, ""));
      await this.command(socket, `MAIL FROM:<${bare(mail.from)}>`, [250]);
      for (const rcpt of mail.to) await this.command(socket, `RCPT TO:<${bare(rcpt)}>`, [250, 251]);
      await this.command(socket, "DATA", [354]);
      const body = buildMime({ ...mail, messageId }).replace(/\r\n\./g, "\r\n..");
      socket.write(body.endsWith("\r\n") ? `${body}.\r\n` : `${body}\r\n.\r\n`);
      this.transcript.push("<message body>");
      await this.expect(socket, [250]);
      await this.command(socket, "QUIT", [221]);
      return messageId;
    } finally {
      socket.end();
    }
  }
}

function bare(address: string): string {
  const m = /<([^>]+)>/.exec(address);
  return (m ? m[1] : address).trim();
}
