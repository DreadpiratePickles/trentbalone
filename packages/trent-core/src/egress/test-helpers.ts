/**
 * Test-only transport helpers for the egress proxy.
 *
 * These speak the raw proxy protocol (HTTP CONNECT, then TLS over the tunnel) because that is the
 * exact path a sandboxed process takes. Nothing here is imported by production code.
 */
import http from "node:http";
import tls from "node:tls";
import type { Socket } from "node:net";

export interface ProxyRequestOptions {
  proxyPort: number;
  host: string;
  port?: number;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  caPem: string;
  body?: string;
}

export interface ProxyResponse {
  /** Status of the CONNECT handshake itself. 200 means the tunnel opened. */
  connectStatus: number;
  /** Status of the tunnelled HTTP request, or null if the tunnel never opened. */
  status: number | null;
  body: string;
  rawHead: string;
}

interface TunnelResult {
  socket: Socket | null;
  connectStatus: number;
}

function openTunnel(proxyPort: number, authority: string): Promise<TunnelResult> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: proxyPort,
      method: "CONNECT",
      path: authority,
      headers: { host: authority },
    });
    req.once("connect", (res, socket: Socket) => {
      resolve({ socket, connectStatus: res.statusCode ?? 0 });
    });
    req.once("response", (res) => {
      res.resume();
      resolve({ socket: null, connectStatus: res.statusCode ?? 0 });
    });
    req.once("error", reject);
    req.end();
  });
}

/** Minimal `Transfer-Encoding: chunked` decoder - upstreams omit Content-Length. */
function decodeChunked(body: string): string {
  let rest = body;
  let out = "";
  for (;;) {
    const eol = rest.indexOf("\r\n");
    if (eol === -1) return out;
    const size = Number.parseInt(rest.slice(0, eol).trim(), 16);
    if (!Number.isFinite(size) || size <= 0) return out;
    out += rest.slice(eol + 2, eol + 2 + size);
    rest = rest.slice(eol + 2 + size + 2);
  }
}

function parseHttpResponse(raw: string): { status: number; head: string; body: string } {
  const split = raw.indexOf("\r\n\r\n");
  const head = split === -1 ? raw : raw.slice(0, split);
  let body = split === -1 ? "" : raw.slice(split + 4);
  if (/transfer-encoding:\s*chunked/i.test(head)) body = decodeChunked(body);
  const match = /^HTTP\/1\.[01] (\d{3})/.exec(head);
  return { status: match ? Number(match[1]) : 0, head, body };
}

/** Perform one request through the proxy exactly as a sandboxed client would. */
export async function proxyRequest(options: ProxyRequestOptions): Promise<ProxyResponse> {
  const port = options.port ?? 443;
  const { socket, connectStatus } = await openTunnel(options.proxyPort, `${options.host}:${port}`);
  // Node emits 'connect' for any CONNECT response, refusals included. A refused tunnel has no TLS.
  if (!socket || connectStatus !== 200) {
    socket?.destroy();
    return { connectStatus, status: null, body: "", rawHead: "" };
  }

  return await new Promise<ProxyResponse>((resolve, reject) => {
    const secure = tls.connect(
      { socket, servername: options.host, ca: [options.caPem] },
      () => {
        const method = options.method ?? "GET";
        const body = options.body ?? "";
        const lines = [
          `${method} ${options.path} HTTP/1.1`,
          `Host: ${options.host}`,
          "Connection: close",
        ];
        for (const [k, v] of Object.entries(options.headers ?? {})) lines.push(`${k}: ${v}`);
        if (body) lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
        secure.write(`${lines.join("\r\n")}\r\n\r\n${body}`);
      }
    );
    const chunks: Buffer[] = [];
    secure.on("data", (c: Buffer) => chunks.push(c));
    secure.on("error", reject);
    secure.on("close", () => {
      const parsed = parseHttpResponse(Buffer.concat(chunks).toString("utf8"));
      resolve({ connectStatus, status: parsed.status, body: parsed.body, rawHead: parsed.head });
    });
  });
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface RecordingUpstream {
  port: number;
  requests: RecordedRequest[];
  close(): Promise<void>;
}
