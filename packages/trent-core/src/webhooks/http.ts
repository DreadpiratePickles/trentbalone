/**
 * [H3] The node:http side of the engine, mounted on `gateway/WebhookServer.ts`: a configured route
 * path is handed here before the chat adapters' `/webhooks/<platform>` match. The body is read raw
 * up to the cap (the signature is over those exact bytes), the peer and the listener's own address
 * are taken from the socket, and the engine's answer is written back as it stands.
 */
import type http from "node:http";
import type { WebhookEngine } from "./engine.js";

/** The same 1 MiB the adapters' path allows. */
export const MAX_ROUTE_BODY_BYTES = 1024 * 1024;

export interface WebhookRoutesHandler {
  matches(pathname: string): boolean;
  serve(req: http.IncomingMessage, res: http.ServerResponse, boundAddress: string): void;
}

export function webhookHttpHandler(engine: WebhookEngine): WebhookRoutesHandler {
  return {
    matches: (pathname) => engine.match(pathname) !== undefined,
    serve(req, res, boundAddress) {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        const headers: Record<string, string | undefined> = {};
        for (const [name, value] of Object.entries(req.headers)) headers[name.toLowerCase()] = Array.isArray(value) ? value.join(",") : value;
        void engine
          .deliver({ method: req.method ?? "GET", path, headers, body: Buffer.concat(chunks), truncated, peer: req.socket.remoteAddress ?? "", boundAddress })
          .then((out) => {
            res.writeHead(out.status, { ...(out.headers ?? {}), ...(truncated ? { connection: "close" } : {}) });
            // An over-cap sender is still streaming: the socket goes once the answer is out.
            res.end(out.body, () => {
              if (truncated) req.destroy();
            });
          })
          .catch(() => {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "webhook error" }));
          });
      };
      req.on("data", (chunk: Buffer) => {
        if (truncated) return;
        size += chunk.length;
        if (size > MAX_ROUTE_BODY_BYTES) {
          truncated = true;
          chunks.length = 0;
          finish();
        } else chunks.push(chunk);
      });
      req.on("end", finish);
      req.on("error", () => {
        done = true;
      });
    },
  };
}
