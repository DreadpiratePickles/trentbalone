/**
 * Minimal IMAP4rev1 client (RFC 3501): LOGIN, SELECT, UID SEARCH, UID FETCH with literals,
 * UID STORE \Seen, LOGOUT. Enough to poll an inbox for new mail and mark it read.
 */

import { LineSocket, type Security } from "./lineSocket.js";

export interface ImapOptions {
  host: string;
  port: number;
  security: Security;
  user: string;
  pass: string;
  mailbox?: string;
  timeoutMs?: number;
}

export interface FetchedMessage {
  uid: number;
  headers: Record<string, string>;
  text: string;
}

const HEADER_FIELDS = "FROM TO SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES";

export class ImapClient {
  readonly transcript: string[] = [];
  private socket?: LineSocket;
  private tag = 0;

  constructor(private readonly options: ImapOptions) {}

  private async command(cmd: string, log = cmd): Promise<string[]> {
    if (!this.socket) throw new Error("imap: not connected");
    const tag = `A${String(++this.tag).padStart(3, "0")}`;
    this.transcript.push(log);
    this.socket.writeLine(`${tag} ${cmd}`);
    const lines: string[] = [];
    for (;;) {
      let line = await this.socket.readLine();
      // A literal `{N}` at end of line means N raw bytes follow, then the line continues.
      let m: RegExpExecArray | null;
      while ((m = /\{(\d+)\}$/.exec(line)) !== null) {
        const bytes = await this.socket.readBytes(Number(m[1]));
        line = `${line.slice(0, m.index)}\u0000${bytes.toString("utf8")}\u0000${await this.socket.readLine()}`;
      }
      if (line.startsWith(`${tag} `)) {
        if (!line.startsWith(`${tag} OK`)) throw new Error(`imap: ${cmd.split(" ")[0]} failed: ${line.slice(tag.length + 1)}`);
        return lines;
      }
      lines.push(line);
    }
  }

  async connect(): Promise<void> {
    const s = new LineSocket(this.options.timeoutMs);
    await s.connect(this.options.host, this.options.port, this.options.security);
    this.socket = s;
    const greeting = await s.readLine();
    if (!greeting.startsWith("* OK") && !greeting.startsWith("* PREAUTH")) throw new Error("imap: bad greeting");
    if (this.options.security === "starttls") {
      await this.command("STARTTLS");
      await s.upgradeTls(this.options.host);
    }
    await this.command(`LOGIN ${quote(this.options.user)} ${quote(this.options.pass)}`, "LOGIN [redacted]");
    await this.command(`SELECT ${quote(this.options.mailbox ?? "INBOX")}`);
  }

  async searchUnseen(afterUid?: number): Promise<number[]> {
    const criteria = afterUid !== undefined ? `UID ${afterUid + 1}:* UNSEEN` : "UNSEEN";
    const lines = await this.command(`UID SEARCH ${criteria}`);
    const search = lines.find((l) => l.startsWith("* SEARCH"));
    if (!search) return [];
    return search.slice("* SEARCH".length).trim().split(/\s+/).filter(Boolean).map(Number).filter((n) => afterUid === undefined || n > afterUid);
  }

  async fetch(uid: number): Promise<FetchedMessage> {
    const lines = await this.command(`UID FETCH ${uid} (BODY.PEEK[HEADER.FIELDS (${HEADER_FIELDS})] BODY.PEEK[TEXT])`);
    const joined = lines.join("\n");
    const literals = joined.split("\u0000");
    // literals: [prefix, header-literal, between, text-literal, suffix]
    const headerRaw = literals[1] ?? "";
    const textRaw = literals[3] ?? "";
    return { uid, headers: parseHeaders(headerRaw), text: decodeBody(textRaw, parseHeaders(headerRaw)) };
  }

  async markSeen(uid: number): Promise<void> {
    await this.command(`UID STORE ${uid} +FLAGS (\\Seen)`);
  }

  async logout(): Promise<void> {
    try {
      await this.command("LOGOUT");
    } catch {
      // The server may drop the connection right after BYE; that is fine.
    } finally {
      this.socket?.end();
      this.socket = undefined;
    }
  }
}

function quote(value: string): string {
  return `"${value.replace(/(["\\])/g, "\\$1")}"`;
}

export function parseHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const unfolded = raw.replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    out[line.slice(0, idx).trim().toLowerCase()] = decodeWords(line.slice(idx + 1).trim());
  }
  return out;
}

function decodeWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_m, _cs: string, enc: string, data: string) =>
    enc.toLowerCase() === "b" ? Buffer.from(data, "base64").toString("utf8") : data.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16))),
  );
}

/** Plain text bodies only: base64 / quoted-printable decoded when the top-level part says so. */
function decodeBody(raw: string, _headers: Record<string, string>): string {
  const trimmed = raw.replace(/\r\n/g, "\n");
  if (/^[A-Za-z0-9+/=\s]+$/.test(trimmed) && trimmed.replace(/\s/g, "").length % 4 === 0 && trimmed.length > 0) {
    const decoded = Buffer.from(trimmed.replace(/\s/g, ""), "base64").toString("utf8");
    if (!decoded.includes("\uFFFD")) return decoded;
  }
  return trimmed.replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16)));
}

/** The address inside `Name <addr>` or a bare address, lower-cased. */
export function bareAddress(value: string | undefined): string {
  if (!value) return "";
  const m = /<([^>]+)>/.exec(value);
  return (m ? m[1] : value).trim().toLowerCase();
}

/** Drops quoted history so a reply body carries only what the human typed. */
export function stripQuotedReply(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    if (/^>/.test(line) || /^On .+wrote:$/.test(line.trim()) || /^-----Original Message-----$/.test(line.trim())) break;
    out.push(line);
  }
  return out.join("\n").trim();
}
