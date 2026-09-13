/**
 * A line-oriented TCP/TLS socket for the SMTP and IMAP clients: connect, read one
 * CRLF-terminated line (or N raw bytes for IMAP literals), write, upgrade to TLS.
 */

import net from "node:net";
import tls from "node:tls";

export type Security = "tls" | "starttls" | "none";

export class LineSocket {
  private socket!: net.Socket;
  private buffer = Buffer.alloc(0);
  private waiters: Array<() => boolean> = [];
  private closed = false;
  private error?: Error;

  constructor(private readonly timeoutMs = 30_000) {}

  async connect(host: string, port: number, security: Security): Promise<void> {
    const socket = security === "tls"
      ? tls.connect({ host, port, servername: host })
      : net.connect({ host, port });
    await this.attach(socket, security === "tls" ? "secureConnect" : "connect");
  }

  async upgradeTls(host: string): Promise<void> {
    const plain = this.socket;
    plain.removeAllListeners("data");
    const secure = tls.connect({ socket: plain, servername: host });
    await this.attach(secure, "secureConnect");
  }

  private attach(socket: net.Socket, readyEvent: string): Promise<void> {
    this.socket = socket;
    socket.setTimeout(this.timeoutMs, () => socket.destroy(new Error("socket timeout")));
    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.pump();
    });
    socket.on("error", (err: Error) => { this.error = err; this.pump(); });
    socket.on("close", () => { this.closed = true; this.pump(); });
    return new Promise((resolve, reject) => {
      socket.once(readyEvent, () => resolve());
      socket.once("error", reject);
    });
  }

  private pump(): void {
    this.waiters = this.waiters.filter((w) => !w());
  }

  private wait(tryResolve: () => boolean): Promise<void> {
    if (tryResolve()) return Promise.resolve();
    return new Promise((resolve) => {
      this.waiters.push(() => {
        if (tryResolve()) { resolve(); return true; }
        return false;
      });
    });
  }

  async readLine(): Promise<string> {
    let line: string | undefined;
    await this.wait(() => {
      const idx = this.buffer.indexOf("\r\n");
      if (idx !== -1) {
        line = this.buffer.subarray(0, idx).toString("utf8");
        this.buffer = this.buffer.subarray(idx + 2);
        return true;
      }
      if (this.error) throw this.error;
      if (this.closed) throw new Error("socket closed");
      return false;
    });
    return line as string;
  }

  async readBytes(n: number): Promise<Buffer> {
    let out: Buffer | undefined;
    await this.wait(() => {
      if (this.buffer.length >= n) {
        out = Buffer.from(this.buffer.subarray(0, n));
        this.buffer = this.buffer.subarray(n);
        return true;
      }
      if (this.error) throw this.error;
      if (this.closed) throw new Error("socket closed");
      return false;
    });
    return out as Buffer;
  }

  write(data: string | Buffer): void {
    this.socket.write(data);
  }

  writeLine(line: string): void {
    this.socket.write(`${line}\r\n`);
  }

  end(): void {
    this.socket.end();
    this.socket.destroy();
  }
}
