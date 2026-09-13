/**
 * Local SMTP and IMAP servers speaking just enough of RFC 5321 / RFC 3501 for the
 * EmailAdapter's wire tests. Plaintext only; the adapter is configured with security=none.
 */

import net from "node:net";
import type { AddressInfo } from "node:net";

export interface CapturedMail { from: string; to: string[]; data: string }

export class FakeSmtpServer {
  readonly commands: string[] = [];
  readonly mails: CapturedMail[] = [];
  private server?: net.Server;
  port = 0;

  async start(): Promise<number> {
    this.server = net.createServer((socket) => {
      let buffer = "";
      let inData = false;
      let current: CapturedMail = { from: "", to: [], data: "" };
      socket.write("220 fake.smtp ESMTP ready\r\n");
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        for (;;) {
          if (inData) {
            const end = buffer.indexOf("\r\n.\r\n");
            if (end === -1) return;
            current.data = buffer.slice(0, end + 2).replace(/\r\n\.\./g, "\r\n.");
            buffer = buffer.slice(end + 5);
            this.mails.push(current);
            current = { from: "", to: [], data: "" };
            inData = false;
            socket.write("250 2.0.0 queued as 1\r\n");
            continue;
          }
          const idx = buffer.indexOf("\r\n");
          if (idx === -1) return;
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          this.commands.push(line.startsWith("AUTH PLAIN") ? "AUTH PLAIN <credentials>" : line);
          if (line.startsWith("EHLO")) socket.write("250-fake.smtp\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n");
          else if (line.startsWith("AUTH PLAIN ")) {
            const [, user, pass] = Buffer.from(line.slice(11), "base64").toString("utf8").split("\0");
            socket.write(user === "bot@example.com" && pass === "s3cret" ? "235 2.7.0 ok\r\n" : "535 5.7.8 bad credentials\r\n");
          } else if (line.startsWith("MAIL FROM:")) { current.from = line.slice(10); socket.write("250 2.1.0 ok\r\n"); }
          else if (line.startsWith("RCPT TO:")) { current.to.push(line.slice(8)); socket.write("250 2.1.5 ok\r\n"); }
          else if (line === "DATA") { inData = true; socket.write("354 end data with <CR><LF>.<CR><LF>\r\n"); }
          else if (line === "QUIT") { socket.write("221 2.0.0 bye\r\n"); socket.end(); }
          else socket.write("500 5.5.1 unknown\r\n");
        }
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as AddressInfo).port;
    return this.port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}

export interface FakeImapMessage { uid: number; headers: string; text: string; seen?: boolean }

export class FakeImapServer {
  readonly commands: string[] = [];
  messages: FakeImapMessage[] = [];
  private server?: net.Server;
  port = 0;

  async start(): Promise<number> {
    this.server = net.createServer((socket) => {
      let buffer = "";
      socket.write("* OK fake.imap IMAP4rev1 ready\r\n");
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        let idx: number;
        while ((idx = buffer.indexOf("\r\n")) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const [tag, ...rest] = line.split(" ");
          const cmd = rest.join(" ");
          this.commands.push(cmd.startsWith("LOGIN") ? "LOGIN <credentials>" : cmd);
          if (cmd.startsWith("LOGIN")) {
            socket.write(cmd === 'LOGIN "bot@example.com" "s3cret"' ? `${tag} OK LOGIN done\r\n` : `${tag} NO LOGIN failed\r\n`);
          } else if (cmd.startsWith("SELECT")) {
            socket.write(`* ${this.messages.length} EXISTS\r\n* FLAGS (\\Seen)\r\n${tag} OK [READ-WRITE] SELECT done\r\n`);
          } else if (cmd.startsWith("UID SEARCH")) {
            const uids = this.messages.filter((m) => !m.seen).map((m) => m.uid).join(" ");
            socket.write(`* SEARCH${uids ? ` ${uids}` : ""}\r\n${tag} OK SEARCH done\r\n`);
          } else if (cmd.startsWith("UID FETCH")) {
            const uid = Number(cmd.split(" ")[2]);
            const m = this.messages.find((x) => x.uid === uid);
            if (m) {
              const hdr = Buffer.from(m.headers, "utf8");
              const txt = Buffer.from(m.text, "utf8");
              socket.write(`* 1 FETCH (UID ${uid} BODY[HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES)] {${hdr.length}}\r\n`);
              socket.write(hdr);
              socket.write(` BODY[TEXT] {${txt.length}}\r\n`);
              socket.write(txt);
              socket.write(")\r\n");
            }
            socket.write(`${tag} OK FETCH done\r\n`);
          } else if (cmd.startsWith("UID STORE")) {
            const uid = Number(cmd.split(" ")[2]);
            const m = this.messages.find((x) => x.uid === uid);
            if (m) m.seen = true;
            socket.write(`* 1 FETCH (UID ${uid} FLAGS (\\Seen))\r\n${tag} OK STORE done\r\n`);
          } else if (cmd === "LOGOUT") {
            socket.write(`* BYE\r\n${tag} OK LOGOUT done\r\n`);
            socket.end();
          } else {
            socket.write(`${tag} BAD unknown\r\n`);
          }
        }
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as AddressInfo).port;
    return this.port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}
