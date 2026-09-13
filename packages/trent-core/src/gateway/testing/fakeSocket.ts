/**
 * A local WebSocket server for gateway wire tests (Discord gateway, Slack Socket Mode).
 * Records every frame the client sends and lets a test push frames back.
 */

import { WebSocketServer, type WebSocket } from "ws";
import type { AddressInfo } from "node:net";

export class FakeSocketServer {
  readonly received: unknown[] = [];
  private wss?: WebSocketServer;
  private sockets: WebSocket[] = [];
  private onConnect?: (socket: WebSocket) => void;
  url = "";

  whenConnected(fn: (socket: WebSocket) => void): this {
    this.onConnect = fn;
    return this;
  }

  async start(): Promise<string> {
    this.wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => this.wss!.once("listening", resolve));
    this.wss.on("connection", (socket) => {
      this.sockets.push(socket);
      socket.on("message", (data) => {
        const text = data.toString();
        try {
          this.received.push(JSON.parse(text));
        } catch {
          this.received.push(text);
        }
      });
      this.onConnect?.(socket);
    });
    const { port } = this.wss.address() as AddressInfo;
    this.url = `ws://127.0.0.1:${port}`;
    return this.url;
  }

  send(frame: unknown): void {
    for (const s of this.sockets) if (s.readyState === s.OPEN) s.send(JSON.stringify(frame));
  }

  get connections(): number {
    return this.sockets.length;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.terminate();
    await new Promise<void>((resolve) => (this.wss ? this.wss.close(() => resolve()) : resolve()));
  }
}
