/**
 * A `fetch`-shaped client that speaks to Trent's EgressProxy the way a sandboxed process does:
 * HTTP CONNECT, then TLS over the tunnel, with the opaque broker token in a header the proxy
 * recognises. Plain http targets go through the proxy's forward path. Redirects are followed by
 * hand so every hop is re-validated against the SSRF floors before a new tunnel is opened.
 *
 * Built on node:http / node:tls only, so no dependency is added for a proxy-aware fetch.
 */
import http from "node:http";
import net, { type Socket } from "node:net";
import tls from "node:tls";
import { checkUrlSafety, type LookupFn } from "./url-safety.js";

export interface EgressClientOptions {
  /** e.g. http://127.0.0.1:8089 */
  proxyUrl: string;
  /** PEM of the proxy's interception CA. */
  caPem?: string;
  /** The opaque broker token. Never a real secret. */
  token: string;
  lookup?: LookupFn;
  /** Re-validate redirect targets (default true). Provider hosts are trusted on the first hop. */
  maxRedirects?: number;
  timeoutMs?: number;
}

export type FetchLike = typeof fetch;

export class EgressRefusedError extends Error {
  constructor(
    public readonly status: number,
    public readonly reason: string,
    public readonly host: string
  ) {
    super(`egress proxy refused ${host}: HTTP ${status} ${reason}`);
    this.name = "EgressRefusedError";
  }
}

export class RedirectBlockedError extends Error {
  constructor(public readonly location: string, public readonly reason: string) {
    super(`redirect to ${location} blocked: ${reason}`);
    this.name = "RedirectBlockedError";
  }
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function headersToRecord(init: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!init) return out;
  if (init instanceof Headers) {
    init.forEach((v, k) => {
      out[k.toLowerCase()] = v;
    });
  } else if (Array.isArray(init)) {
    for (const [k, v] of init) out[k.toLowerCase()] = v;
  } else {
    for (const [k, v] of Object.entries(init)) out[k.toLowerCase()] = v;
  }
  return out;
}

function proxyAddress(proxyUrl: string): { host: string; port: number } {
  const u = new URL(proxyUrl);
  return { host: u.hostname, port: Number(u.port) || 80 };
}

function openTunnel(
  proxy: { host: string; port: number },
  authority: string,
  timeoutMs: number
): Promise<{ socket: Socket | null; status: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxy.host,
      port: proxy.port,
      method: "CONNECT",
      path: authority,
      headers: { host: authority },
      timeout: timeoutMs,
    });
    req.once("connect", (res, socket: Socket) => {
      const reason = String(res.headers["x-trent-egress-reason"] ?? res.statusMessage ?? "");
      resolve({ socket, status: res.statusCode ?? 0, reason });
    });
    req.once("response", (res) => {
      res.resume();
      resolve({
        socket: null,
        status: res.statusCode ?? 0,
        reason: String(res.headers["x-trent-egress-reason"] ?? res.statusMessage ?? ""),
      });
    });
    req.once("timeout", () => req.destroy(new Error("CONNECT timed out")));
    req.once("error", reject);
    req.end();
  });
}

function sendOverSocket(
  socket: Socket,
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  timeoutMs: number,
  viaPlainProxy: boolean
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        createConnection: () => socket,
        host: url.hostname,
        path: viaPlainProxy ? url.toString() : `${url.pathname}${url.search}`,
        method,
        headers: { host: url.host, ...headers, connection: "close" },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) })
        );
        res.on("error", reject);
      }
    );
    req.once("timeout", () => req.destroy(new Error("request timed out")));
    req.once("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function requestOnce(
  options: EgressClientOptions,
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: string | undefined
): Promise<RawResponse> {
  const proxy = proxyAddress(options.proxyUrl);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const withToken = { ...headers, "x-trent-proxy-token": options.token };

  if (url.protocol === "http:") {
    // Plain targets use the proxy's forward path, which applies the same allowlist and token gate.
    const plain = await new Promise<Socket>((resolve, reject) => {
      const sock = net.connect(proxy.port, proxy.host, () => resolve(sock));
      sock.once("error", reject);
    });
    return sendOverSocket(plain, url, method, withToken, body, timeoutMs, true);
  }

  const port = Number(url.port) || 443;
  const tunnel = await openTunnel(proxy, `${url.hostname}:${port}`, timeoutMs);
  if (!tunnel.socket || tunnel.status !== 200) {
    tunnel.socket?.destroy();
    throw new EgressRefusedError(tunnel.status, tunnel.reason || "refused", url.hostname);
  }
  const secure = tls.connect({
    socket: tunnel.socket,
    servername: url.hostname,
    ...(options.caPem ? { ca: [options.caPem] } : {}),
  });
  await new Promise<void>((resolve, reject) => {
    secure.once("secureConnect", resolve);
    secure.once("error", reject);
  });
  return sendOverSocket(secure, url, method, withToken, body, timeoutMs, false);
}

/**
 * Build the fetch-shaped function. Only the subset the wrapped adapters use is implemented:
 * string/URL input, method, headers, string body, signal (checked between hops).
 */
export function createEgressFetch(options: EgressClientOptions): FetchLike {
  const maxRedirects = options.maxRedirects ?? 5;
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    let url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = headersToRecord(init?.headers);
    const body = typeof init?.body === "string" ? init.body : undefined;

    for (let hop = 0; ; hop += 1) {
      if (init?.signal?.aborted) throw new Error("request aborted");
      const raw = await requestOnce(options, url, method, headers, body);
      const location = raw.headers.location;
      if (raw.status >= 300 && raw.status < 400 && typeof location === "string") {
        if (hop >= maxRedirects) throw new RedirectBlockedError(location, "too many redirects");
        const next = new URL(location, url);
        // The floor is re-applied on every hop, DNS included, so a provider cannot bounce a seat
        // onto a private address.
        const verdict = await checkUrlSafety(next.toString(), { lookup: options.lookup });
        if (!verdict.ok) throw new RedirectBlockedError(next.toString(), verdict.reason);
        url = next;
        continue;
      }
      const noBody = raw.status === 204 || raw.status === 304 || raw.status < 200;
      const responseHeaders = new Headers();
      for (const [k, v] of Object.entries(raw.headers)) {
        if (typeof v === "string") responseHeaders.set(k, v);
        else if (Array.isArray(v)) responseHeaders.set(k, v.join(", "));
      }
      return new Response(noBody ? null : new Uint8Array(raw.body), {
        status: raw.status,
        headers: responseHeaders,
      });
    }
  };
  return impl as FetchLike;
}
