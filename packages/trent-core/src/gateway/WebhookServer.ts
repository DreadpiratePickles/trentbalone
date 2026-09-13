/**
 * One HTTP listener for every webhook-capable adapter: `/webhooks/<platform>` is handed
 * to that adapter's `handleWebhook`. Bodies are read raw so signatures verify byte-exact.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import type { GatewayManager } from "./GatewayManager.js";
import { listPlatformIds } from "./registry.js";

export const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

export class WebhookServer {
  private server?: http.Server;

  constructor(private readonly manager: GatewayManager) {}

  async listen(port: number, host = "127.0.0.1"): Promise<number> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, host, () => resolve());
    });
    return (this.server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections?.();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    const m = /^\/webhooks\/([a-z]+)$/.exec(url.pathname);
    const platform = m?.[1];
    const adapter = platform && listPlatformIds().includes(platform) ? this.manager.getAdapter(platform) : undefined;
    if (!adapter || !adapter.handleWebhook) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_WEBHOOK_BODY_BYTES) req.destroy();
      else chunks.push(c);
    });
    req.on("end", () => {
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(",") : v;
      void adapter.handleWebhook!({ method: req.method ?? "GET", url: req.url ?? "/", headers, body: Buffer.concat(chunks).toString("utf8") })
        .then((out) => {
          res.writeHead(out.status, { "content-type": "text/plain", ...(out.headers ?? {}) });
          res.end(out.body);
        })
        .catch(() => {
          res.writeHead(500, { "content-type": "text/plain" });
          res.end("webhook error");
        });
    });
  }
}
