/**
 * A local HTTP server for wire tests. Each test registers handlers that implement the
 * platform's documented request/response shapes; the adapter is pointed at the server via
 * `baseUrls`. Every request is recorded so tests can assert the exact bytes we sent.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
  json: unknown;
}

export type RouteHandler = (
  req: RecordedRequest,
  res: http.ServerResponse,
) => void | Promise<void>;

export class FakeServer {
  readonly requests: RecordedRequest[] = [];
  private readonly routes: Array<{ method: string; test: (path: string) => boolean; handler: RouteHandler }> = [];
  private server?: http.Server;
  private url = "";

  on(method: string, path: string | RegExp, handler: RouteHandler): this {
    const test = typeof path === "string" ? (p: string) => p === path || p.startsWith(`${path}?`) : (p: string) => path.test(p);
    this.routes.unshift({ method, test, handler }); // later registrations override earlier ones
    return this;
  }

  get baseUrl(): string {
    return this.url;
  }

  get httpServer(): http.Server {
    if (!this.server) throw new Error("not started");
    return this.server;
  }

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        let json: unknown;
        try {
          json = body === "" ? undefined : JSON.parse(body);
        } catch {
          json = undefined;
        }
        const recorded: RecordedRequest = { method: req.method ?? "", path: req.url ?? "", headers: req.headers, body, json };
        this.requests.push(recorded);
        const route = this.routes.find((r) => r.method === recorded.method && r.test(recorded.path));
        if (!route) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: `no route for ${recorded.method} ${recorded.path}` }));
          return;
        }
        Promise.resolve(route.handler(recorded, res)).catch((err: unknown) => {
          res.writeHead(500);
          res.end(String(err));
        });
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const { port } = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections?.();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  find(method: string, pathPrefix: string): RecordedRequest[] {
    return this.requests.filter((r) => r.method === method && r.path.startsWith(pathPrefix));
  }
}

export function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
