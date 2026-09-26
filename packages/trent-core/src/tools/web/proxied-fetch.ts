/**
 * A `fetch`-shaped client that speaks to Trent's EgressProxy the way a sandboxed process does:
 * HTTP CONNECT, then TLS over the tunnel, with the opaque broker token in a header the proxy
 * recognises. Plain http targets go through the proxy's forward path. Redirects are followed by
 * hand so every hop is re-validated against the SSRF floors before a new tunnel is opened.
 *
 * [C4] `init.redirect` is honoured ("error" throws on a 3xx with a Location, "manual" returns it), and
 * a followed hop to another origin drops the caller's credentials and body (`nextRedirectHop`). That
 * rule is the one every Trent fetch uses; the MCP http transport refuses where this one strips.
 *
 * Built on node:http / node:tls only, so no dependency is added for a proxy-aware fetch.
 */
import http from "node:http";
import net, { type Socket } from "node:net";
import tls from "node:tls";
import { checkUrlSafety, type LookupFn } from "./url-safety.js";
import { OWN_CREDENTIAL_HEADER } from "../../egress/CredentialBroker.js"; // [C4]

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

// [C4] The one redirect rule.
/** Redirects a followed request may take before it is refused. */
export const MAX_REDIRECTS = 5;

/**
 * Headers that carry a credential, dropped on a hop to another origin. `x-api-key` and
 * `x-goog-api-key` are here because the broker reads a token from them too (`CredentialBroker.ts`).
 */
export const CROSS_ORIGIN_DROPPED_HEADERS: readonly string[] = [
  "authorization",
  "cookie",
  "proxy-authorization",
  "x-trent-proxy-token",
  OWN_CREDENTIAL_HEADER,
  "x-api-key",
  "x-goog-api-key",
];

/** Headers that describe a body, dropped with it (WHATWG fetch "request-body-header name", plus framing). */
const BODY_HEADERS: readonly string[] = ["content-type", "content-length", "content-encoding", "content-language", "content-location", "transfer-encoding"];

/** One request of a redirect chain. */
export interface RedirectHop {
  readonly url: URL;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | undefined;
  /** True once a hop left the origin the caller named: its credentials are gone for the rest of the chain. */
  readonly stripped: boolean;
}

/** The URL a 3xx names, resolved against the current one; undefined when the answer is not a redirect. */
export function redirectTarget(status: number, location: string | null | undefined, current: URL): URL | undefined {
  if (status < 300 || status >= 400 || typeof location !== "string" || location === "") return undefined;
  return new URL(location, current);
}

/** Same origin, or the same host upgraded from http to https (docs/mcp.md): the only hops a credential takes. */
export function keepsCredentials(from: URL, to: URL): boolean {
  if (to.origin === from.origin) return true;
  return from.protocol === "http:" && to.protocol === "https:" && to.hostname === from.hostname;
}

function withoutHeaders(headers: Readonly<Record<string, string>>, names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) if (!names.includes(name.toLowerCase())) out[name] = value;
  return out;
}

/**
 * The request after a redirect, as fetch builds it (WHATWG fetch, "HTTP-redirect fetch"): 301/302 turn
 * a POST into a GET and 303 turns anything but GET/HEAD into a GET, without the body. To another origin
 * the credential headers and the body are dropped; a 307/308 that must re-send a body there is refused,
 * since it can be followed only by leaking the body or by sending a different request.
 */
export function nextRedirectHop(current: RedirectHop, status: number, target: URL): RedirectHop {
  let { method, headers, body } = current;
  const toGet = ((status === 301 || status === 302) && method === "POST") || (status === 303 && method !== "GET" && method !== "HEAD");
  if (toGet) {
    method = "GET";
    body = undefined;
    headers = withoutHeaders(headers, BODY_HEADERS);
  }
  if (keepsCredentials(current.url, target)) return { url: target, method, headers, body, stripped: current.stripped };
  if (body !== undefined) throw new RedirectBlockedError(target.toString(), `a ${status} would re-send the request body to another origin`);
  return { url: target, method, headers: withoutHeaders(headers, [...CROSS_ORIGIN_DROPPED_HEADERS, ...BODY_HEADERS]), body: undefined, stripped: true };
}

/** Why the SSRF floor refuses a redirect target, DNS included, or undefined when it may be followed. */
export async function redirectRefusal(target: URL, lookup?: LookupFn): Promise<string | undefined> {
  const verdict = await checkUrlSafety(target.toString(), { lookup });
  return verdict.ok ? undefined : verdict.reason;
}
// [/C4]

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
  headers: Readonly<Record<string, string>>, // [C4]
  body: string | undefined,
  stripped: boolean // [C4]
): Promise<RawResponse> {
  const proxy = proxyAddress(options.proxyUrl);
  const timeoutMs = options.timeoutMs ?? 30_000;
  // [C4] The proxy's gate needs the token on every hop (it answers 407 without one) and strips it
  // before any origin. A stripped hop also carries the own-credential marker, so the broker writes no
  // brokered secret into a request to a host the caller never named.
  const withToken = { ...headers, ...(stripped ? { [OWN_CREDENTIAL_HEADER]: "1" } : {}), "x-trent-proxy-token": options.token };

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
 * string/URL input, method, headers, string body, redirect ([C4]), signal (checked between hops).
 */
export function createEgressFetch(options: EgressClientOptions): FetchLike {
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS; // [C4]
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    // [C4] One hop at a time through the shared rule; `redirect` is honoured as fetch honours it.
    const mode = init?.redirect ?? "follow";
    let hop: RedirectHop = {
      url: new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url),
      method: (init?.method ?? "GET").toUpperCase(),
      headers: headersToRecord(init?.headers),
      body: typeof init?.body === "string" ? init.body : undefined,
      stripped: false,
    };

    for (let count = 0; ; count += 1) {
      if (init?.signal?.aborted) throw new Error("request aborted");
      const raw = await requestOnce(options, hop.url, hop.method, hop.headers, hop.body, hop.stripped);
      const target = redirectTarget(raw.status, raw.headers.location, hop.url);
      if (target !== undefined && mode !== "manual") {
        if (mode === "error") throw new RedirectBlockedError(target.toString(), 'the request was made with redirect: "error"');
        if (count >= maxRedirects) throw new RedirectBlockedError(target.toString(), "too many redirects");
        // The floor is re-applied on every hop, DNS included, so a provider cannot bounce a seat
        // onto a private address.
        const refusal = await redirectRefusal(target, options.lookup);
        if (refusal !== undefined) throw new RedirectBlockedError(target.toString(), refusal);
        hop = nextRedirectHop(hop, raw.status, target);
        continue;
      }
      // [/C4]
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
