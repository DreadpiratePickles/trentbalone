/**
 * A local HTTP server standing in for one provider (Stripe, Google Calendar, Square, Twilio) in
 * the business toolset's tests. It records every request it receives — method, path, query,
 * headers, decoded form or JSON body — and answers from the routes a test registers, so a test
 * can assert that exactly the previewed payload arrived exactly once. Nothing here talks to a
 * real provider; the base URL is `http://127.0.0.1:<random port>`.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly headers: Record<string, string>;
  readonly body: string;
  /** The body decoded as `application/x-www-form-urlencoded`, when it was one. */
  readonly form?: URLSearchParams;
  /** The body parsed as JSON, when it was one. */
  readonly json?: unknown;
}

export interface FakeResponse {
  readonly status: number;
  readonly body: unknown;
}

export type FakeHandler = (request: RecordedRequest, match: RegExpMatchArray) => FakeResponse;

interface Route {
  readonly method: string;
  readonly pattern: RegExp;
  readonly handler: FakeHandler;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export class FakeProviderServer {
  readonly requests: RecordedRequest[] = [];
  private readonly routes: Route[] = [];
  private server: http.Server | undefined;
  private base = "";

  /** Registers a route; the first matching route answers. */
  on(method: string, pattern: RegExp, handler: FakeHandler): this {
    this.routes.push({ method: method.toUpperCase(), pattern, handler });
    return this;
  }

  get url(): string {
    return this.base;
  }

  /** Requests to one path (regex), in arrival order. */
  received(method: string, pattern: RegExp): RecordedRequest[] {
    return this.requests.filter((request) => request.method === method.toUpperCase() && pattern.test(request.path));
  }

  async start(): Promise<string> {
    this.server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const body = await readBody(req);
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) if (typeof value === "string") headers[key.toLowerCase()] = value;
      const contentType = headers["content-type"] ?? "";
      const recorded: RecordedRequest = {
        method: (req.method ?? "GET").toUpperCase(),
        path: url.pathname,
        query: url.searchParams,
        headers,
        body,
        ...(contentType.includes("application/x-www-form-urlencoded") ? { form: new URLSearchParams(body) } : {}),
        ...(contentType.includes("application/json") && body !== "" ? { json: JSON.parse(body) as unknown } : {}),
      };
      this.requests.push(recorded);
      for (const route of this.routes) {
        if (route.method !== recorded.method) continue;
        const match = url.pathname.match(route.pattern);
        if (match === null) continue;
        const answer = route.handler(recorded, match);
        res.writeHead(answer.status, { "content-type": "application/json" });
        res.end(JSON.stringify(answer.body));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `no fake route for ${recorded.method} ${url.pathname}` } }));
    });
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    const address = this.server.address() as AddressInfo;
    this.base = `http://127.0.0.1:${address.port}`;
    return this.base;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server === undefined) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
