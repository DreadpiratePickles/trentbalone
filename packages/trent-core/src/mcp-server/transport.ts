/**
 * U5 / G9 — the two transports `trent mcp serve` speaks, with the rules the specification and
 * the A2A card put on them.
 *
 * stdio: the host spawned this process and owns its pipes; nothing but protocol goes to stdout,
 * and the promise resolves when the host closes the pipe.
 *
 * Streamable HTTP: one endpoint (`/mcp`), POST and GET, sessions by `Mcp-Session-Id`. Loopback
 * by default. A bearer token is REQUIRED before a non-loopback host is bound at all, because the
 * A2A card is explicit that an absent token means anyone may call (`a2a/card.ts`), and a server
 * that anyone on the network may call is a server that runs Trent's tools for anyone on the
 * network. `Origin` is validated on every request (the specification's DNS-rebinding rule): a
 * browser origin that is not this server's own loopback is refused. Every session gets its own
 * Trent server and therefore its own run scope; the token value is compared in constant time and
 * never appears in anything the server reports about itself.
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { EXIT, TrentError } from "../errors/index.js";
import type { TrentMcpServer } from "./server.js";

export const MCP_HTTP_PATH = "/mcp";
export const MCP_DEFAULT_HOST = "127.0.0.1";
export const MCP_DEFAULT_PORT = 7896;
/** The message a caller gets when the bearer token is missing or wrong; the same words as A2A's. */
export const MCP_UNAUTHORIZED = "this endpoint requires the bearer token named by --token-env (TRENT_MCP_TOKEN by default)";
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Loopback names and addresses: what a server may bind without a token. */
export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  return bare === "localhost" || bare === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
}

/** Serves one connection over this process's stdin and stdout; resolves when the host hangs up. */
export async function serveStdio(server: TrentMcpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await new Promise<void>((resolve, reject) => {
    transport.onclose = () => resolve();
    transport.onerror = (error) => reject(error);
    server.connect(transport).catch(reject);
  });
  await server.close();
}

export interface McpHttpOptions {
  readonly host?: string;
  readonly port: number;
  /** The bearer every request must present. Required for a non-loopback `host`. */
  readonly token?: string;
  /** One Trent server per MCP session; it is closed when the session ends. */
  readonly createServer: () => TrentMcpServer;
  readonly log?: (event: string, fields: Record<string, unknown>) => void;
}

export interface McpHttpServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly listening: boolean;
  readonly port: number;
  readonly host: string;
  readonly authenticated: boolean;
  /** What the CLI reports: never the token. */
  describe(): { transport: "http"; host: string; port: number; path: string; authenticated: boolean; sessions: number };
}

interface Session {
  readonly transport: StreamableHTTPServerTransport;
  readonly server: TrentMcpServer;
}

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(res: http.ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function rpcError(res: http.ServerResponse, status: number, message: string): void {
  send(res, status, { jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

/** The Origin header, when present, must be a loopback origin: a page on the web may not drive this server. */
function originAllowed(origin: string | undefined): boolean {
  if (origin === undefined || origin === "") return true;
  try {
    return isLoopbackHost(new URL(origin).hostname);
  } catch {
    return false;
  }
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? undefined : (JSON.parse(text) as unknown);
}

export function createMcpHttpServer(options: McpHttpOptions): McpHttpServer {
  const host = options.host ?? MCP_DEFAULT_HOST;
  const sessions = new Map<string, Session>();
  const log = options.log ?? (() => undefined);
  let server: http.Server | undefined;
  let boundPort = options.port;

  const authorized = (req: http.IncomingMessage): boolean => {
    if (options.token === undefined) return true;
    const header = req.headers.authorization ?? "";
    return header.startsWith("Bearer ") && sameSecret(header.slice("Bearer ".length).trim(), options.token);
  };

  async function openSession(req: http.IncomingMessage, res: http.ServerResponse, body: unknown): Promise<void> {
    const trent = options.createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server: trent });
        log("mcp.serve.session.opened", { session: id, runId: trent.runId });
      },
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id !== undefined && sessions.delete(id)) log("mcp.serve.session.closed", { session: id, runId: trent.runId });
      void trent.close().catch(() => undefined);
    };
    await trent.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? host}`);
    if (url.pathname !== MCP_HTTP_PATH) {
      rpcError(res, 404, `the MCP endpoint is ${MCP_HTTP_PATH}`);
      return;
    }
    if (!originAllowed(req.headers.origin)) {
      rpcError(res, 403, "the Origin header is not a loopback origin of this server");
      return;
    }
    if (!authorized(req)) {
      res.setHeader("WWW-Authenticate", "Bearer");
      rpcError(res, 401, MCP_UNAUTHORIZED);
      return;
    }
    const sessionId = req.headers["mcp-session-id"];
    const id = Array.isArray(sessionId) ? sessionId[0] : sessionId;
    const session = id === undefined ? undefined : sessions.get(id);
    if (session !== undefined) {
      await session.transport.handleRequest(req, res);
      return;
    }
    if (id !== undefined) {
      rpcError(res, 404, "no such session; start a new one with an initialize request");
      return;
    }
    if (req.method !== "POST") {
      rpcError(res, 400, "a request without a session must be a POST initialize request");
      return;
    }
    const body = await readBody(req);
    if (!isInitializeRequest(body)) {
      rpcError(res, 400, "a request without a session must be an initialize request");
      return;
    }
    await openSession(req, res, body);
  }

  return {
    get listening() {
      return server?.listening === true;
    },
    get port() {
      return boundPort;
    },
    host,
    authenticated: options.token !== undefined,
    describe() {
      return { transport: "http", host, port: boundPort, path: MCP_HTTP_PATH, authenticated: options.token !== undefined, sessions: sessions.size };
    },
    async start() {
      if (!isLoopbackHost(host) && options.token === undefined) {
        throw new TrentError({
          code: EXIT.CONFIG,
          operation: "mcp.serve",
          message: "a non-loopback host needs a bearer token: set TRENT_MCP_TOKEN in the profile secrets file or name a variable with --token-env",
          target: host,
        });
      }
      const created = http.createServer((req, res) => {
        handle(req, res).catch((error: unknown) => {
          log("mcp.serve.request.failed", { reason: error instanceof Error ? error.message : String(error) });
          if (!res.headersSent) rpcError(res, 500, "the request could not be handled");
          else res.end();
        });
      });
      await new Promise<void>((resolve, reject) => {
        created.once("error", reject);
        created.listen(options.port, host, () => {
          created.off("error", reject);
          const address = created.address();
          if (address !== null && typeof address === "object") boundPort = address.port;
          resolve();
        });
      });
      server = created;
    },
    async stop() {
      for (const [id, session] of [...sessions]) {
        sessions.delete(id);
        await session.transport.close().catch(() => undefined);
        await session.server.close().catch(() => undefined);
      }
      const current = server;
      server = undefined;
      if (current === undefined) return;
      await new Promise<void>((resolve) => {
        current.close(() => resolve());
        current.closeAllConnections?.();
      });
    },
  };
}
