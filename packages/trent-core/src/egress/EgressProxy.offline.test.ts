/**
 * [O-03] The egress proxy is offline-aware.
 *
 * Offline mode means nothing leaves the machine. The host proxy dials upstream over raw node:https /
 * node:http sockets, not through `trentFetch`, so a host-side tool whose request reached the loopback
 * listener used to pass `trentFetch`'s loopback rule and then leave the machine through the proxy.
 * The property pinned here: while offline, every CONNECT and every plain-HTTP forward is refused
 * (`offline_non_loopback`, 403) unless its upstream is loopback by definition (an IP literal,
 * `localhost`, `*.localhost`) — whatever the allowlist says — before any upstream request is created.
 * No name is ever sent to a resolver offline: the query itself would leave the machine. The injected
 * resolvers below answer (public or loopback) only to prove they are never asked.
 *
 * Upstream requests are counted with spies on `https.request` / `http.request` whose fakes never open
 * a socket, so a leak would be recorded, not performed. Every resolver is injected; no real DNS.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CertificateAuthority } from "./CertificateAuthority.js";
import { TokenManager } from "./TokenManager.js";
import { EgressProxy, type EgressDecision, type EgressProxyOptions } from "./EgressProxy.js";
import { LOOPBACK_ALLOWLIST, offlineInterceptDomains } from "./offline-config.js";
import { proxyRequest, startRecordingUpstream, type RecordingUpstream } from "./test-helpers.js";
import type { LookupFn } from "../tools/web/url-safety.js";

const PUBLIC_HOST = "api.offline-leak.test"; // allowlisted, resolves to public space
const LOCAL_HOST = "svc.localhost"; // allowlisted, loopback by definition (RFC 6761)
const PUBLIC_ADDRESS = "93.184.216.34";
const EXFIL_HOST = "exfil-198-51-100-7.example.com"; // a secret-bearing name: offline it must never reach a resolver

function answering(addresses: string[]): { lookup: LookupFn; calls: string[] } {
  const calls: string[] = [];
  const lookup: LookupFn = async (host) => {
    calls.push(host);
    return addresses.map((address) => ({ address, family: net.isIPv6(address) ? 6 : 4 }));
  };
  return { lookup, calls };
}

/** A stand-in upstream request: it accepts the piped body and fails, without ever opening a socket. */
function fakeUpstreamRequest(): http.ClientRequest {
  const req = new PassThrough();
  setImmediate(() => req.emit("error", Object.assign(new Error("spy: upstream not dialled"), { code: "ESPY" })));
  return req as unknown as http.ClientRequest;
}

/** One absolute-form plain-HTTP request through the proxy. */
function plainProxyRequest(proxyPort: number, url: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request({ host: "127.0.0.1", port: proxyPort, method: "GET", path: url, headers: { host: target.host, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** A raw CONNECT: the handshake's status line and reason header, nothing after it. */
function rawConnect(proxyPort: number, authority: string): Promise<{ status: number; reason: string | null }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, "127.0.0.1", () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nhost: ${authority}\r\n\r\n`));
    let head = "";
    socket.on("data", (chunk: Buffer) => {
      head += chunk.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      socket.destroy();
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1] ?? 0);
      resolve({ status, reason: /x-trent-egress-reason: ([^\r\n]+)/i.exec(head)?.[1] ?? null });
    });
    socket.on("error", reject);
  });
}

describe("[O-03] EgressProxy — offline mode refuses any upstream that is not loopback", () => {
  let upstreamCa: CertificateAuthority;
  let upstream: RecordingUpstream;
  let proxyCa: CertificateAuthority;
  let tokens: TokenManager;
  let token: string;
  const dirs: string[] = [];
  const proxies: EgressProxy[] = [];
  const upstreamRequests: unknown[] = [];

  beforeAll(async () => {
    const [upDir, caDir, tokDir] = ["trent-o03-up-", "trent-o03-ca-", "trent-o03-tok-"].map((p) => fs.mkdtempSync(path.join(os.tmpdir(), p)));
    dirs.push(upDir!, caDir!, tokDir!);
    upstreamCa = new CertificateAuthority({ dir: upDir! });
    const leaf = upstreamCa.issueLeaf(LOCAL_HOST);
    upstream = await startRecordingUpstream(leaf.certPem, leaf.keyPem);
    proxyCa = new CertificateAuthority({ dir: caDir! });
    tokens = new TokenManager({ filePath: path.join(tokDir!, "tokens.json") });
    token = tokens.issueToken("eng-o03", { apiKey: "sk-o03-upstream-secret-0000" }, undefined, { hosts: [PUBLIC_HOST, LOCAL_HOST] });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    upstreamRequests.length = 0;
    for (const p of proxies.splice(0)) await p.stop();
  });

  afterAll(async () => {
    await upstream.close();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  /** Count every upstream request the proxy creates; never dial one. The test's own client calls pass through. */
  function spyUpstream(proxyPort: () => number): void {
    vi.spyOn(https, "request").mockImplementation(((...args: unknown[]) => {
      upstreamRequests.push(args[0]);
      return fakeUpstreamRequest();
    }) as typeof https.request);
    const realHttp = http.request.bind(http);
    vi.spyOn(http, "request").mockImplementation(((...args: unknown[]) => {
      const opts = args[0] as http.RequestOptions;
      if (typeof opts === "object" && opts.host === "127.0.0.1" && opts.port === proxyPort()) return (realHttp as (...a: unknown[]) => http.ClientRequest)(...args);
      upstreamRequests.push(opts);
      return fakeUpstreamRequest();
    }) as typeof http.request);
  }

  async function startProxy(options: Partial<EgressProxyOptions>, decisions: EgressDecision[] = []): Promise<EgressProxy> {
    const proxy = new EgressProxy({
      port: 0,
      ca: proxyCa,
      tokenManager: tokens,
      interceptDomains: [PUBLIC_HOST, LOCAL_HOST],
      upstreamCa: [upstreamCa.getCertPem()],
      onDecision: (d) => decisions.push(d),
      log: () => {},
      ...options,
    });
    await proxy.start();
    proxies.push(proxy);
    return proxy;
  }

  it("offline: a CONNECT to an allowlisted host that resolves public is refused offline_non_loopback and opens no upstream socket", async () => {
    const dns = answering([PUBLIC_ADDRESS]);
    const decisions: EgressDecision[] = [];
    const proxy = await startProxy({ offline: true, lookup: dns.lookup }, decisions);
    spyUpstream(() => proxy.getPort());

    const handshake = await rawConnect(proxy.getPort(), `${PUBLIC_HOST}:443`);
    expect(handshake).toEqual({ status: 403, reason: "offline_non_loopback" });

    // The full client path too: a sandboxed client that keeps going after the handshake gets nothing through.
    const res = await proxyRequest({
      proxyPort: proxy.getPort(), host: PUBLIC_HOST, path: "/v1/leak",
      headers: { authorization: `Bearer ${token}` }, caPem: proxyCa.getCertPem(),
    });
    expect(res.connectStatus).toBe(403);
    expect(upstreamRequests).toEqual([]);
    expect(dns.calls).toEqual([]); // refused unresolved: the name never reaches a resolver
    expect(decisions.filter((d) => d.rule === "offline_non_loopback")).toEqual([
      { host: PUBLIC_HOST, port: 443, verdict: "refused", rule: "offline_non_loopback" },
      { host: PUBLIC_HOST, port: 443, verdict: "refused", rule: "offline_non_loopback" },
    ]);
    expect(decisions.some((d) => d.verdict === "allowed")).toBe(false);
  });

  it("offline: a plain-HTTP forward to an allowlisted host that resolves public is refused offline_non_loopback before any upstream request", async () => {
    const dns = answering([PUBLIC_ADDRESS]);
    const decisions: EgressDecision[] = [];
    const proxy = await startProxy({ offline: true, lookup: dns.lookup }, decisions);
    spyUpstream(() => proxy.getPort());

    const res = await plainProxyRequest(proxy.getPort(), `http://${PUBLIC_HOST}/x`, { authorization: `Bearer ${token}` });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ error: "egress_refused", reason: "offline_non_loopback" });
    expect(upstreamRequests).toEqual([]);
    expect(dns.calls).toEqual([]); // refused unresolved: the name never reaches a resolver
    expect(decisions).toEqual([{ host: PUBLIC_HOST, port: 80, verdict: "refused", rule: "offline_non_loopback" }]);
  });

  // [DNS-name leak] This used to resolve svc.localhost through the injected lookup (and a sibling test
  // refused a mixed loopback+public answer). Offline no name is resolved any more: `*.localhost` is
  // 127.0.0.1 by definition, so the resolver here answers off the machine and must never be asked.
  it("offline: an allowlisted *.localhost upstream is reached at 127.0.0.1 with zero resolver queries", async () => {
    const dns = answering([PUBLIC_ADDRESS]);
    const decisions: EgressDecision[] = [];
    const proxy = await startProxy({ offline: true, lookup: dns.lookup }, decisions);
    const before = upstream.requests.length;
    const res = await proxyRequest({
      proxyPort: proxy.getPort(), host: LOCAL_HOST, port: upstream.port, path: "/v1/local",
      headers: { authorization: `Bearer ${token}` }, caPem: proxyCa.getCertPem(),
    });
    expect(res.connectStatus).toBe(200);
    expect(res.status).toBe(200);
    expect(upstream.requests.length).toBe(before + 1);
    expect(upstream.requests.at(-1)?.headers.host).toBe(LOCAL_HOST);
    expect(dns.calls).toEqual([]); // pinned by definition, never resolved
    expect(decisions.at(-1)).toMatchObject({ host: LOCAL_HOST, verdict: "allowed" });
  });

  it("offline: an upstream override that points off the machine is refused; a loopback override still works", async () => {
    const offMachine = await startProxy({ offline: true, upstreamOverrides: { [PUBLIC_HOST]: { host: PUBLIC_ADDRESS, port: 443 } } });
    spyUpstream(() => offMachine.getPort());
    expect(await rawConnect(offMachine.getPort(), `${PUBLIC_HOST}:443`)).toEqual({ status: 403, reason: "offline_non_loopback" });
    expect(upstreamRequests).toEqual([]);
    vi.restoreAllMocks();

    // No resolver: the override's literal is what is checked, and the request's :443 goes to its port.
    const loopback = await startProxy({ offline: true, upstreamOverrides: { [LOCAL_HOST]: { host: "127.0.0.1", port: upstream.port } } });
    const res = await proxyRequest({
      proxyPort: loopback.getPort(), host: LOCAL_HOST, path: "/v1/override",
      headers: { authorization: `Bearer ${token}` }, caPem: proxyCa.getCertPem(),
    });
    expect(res.connectStatus).toBe(200);
    expect(upstream.requests.at(-1)?.url).toBe("/v1/override");
  });

  // [O-03 DNS-name leak] The resolver below answers loopback, so the old resolve-then-decide rule would
  // have let the name through. The point is that the name is never asked about at all: the query is the leak.
  it("offline: a CONNECT to a non-local name is refused offline_non_loopback with zero resolver queries and no upstream socket", async () => {
    const dns = answering(["127.0.0.1"]);
    const proxy = await startProxy({ offline: true, lookup: dns.lookup, interceptDomains: [EXFIL_HOST] });
    spyUpstream(() => proxy.getPort());
    expect(await rawConnect(proxy.getPort(), `${EXFIL_HOST}:443`)).toEqual({ status: 403, reason: "offline_non_loopback" });
    expect(dns.calls).toEqual([]);
    expect(upstreamRequests).toEqual([]);
  });

  it("offline: a plain-HTTP forward to a non-local name is refused offline_non_loopback with zero resolver queries and no upstream request", async () => {
    const dns = answering(["127.0.0.1"]);
    const proxy = await startProxy({ offline: true, lookup: dns.lookup, interceptDomains: [EXFIL_HOST] });
    spyUpstream(() => proxy.getPort());
    const res = await plainProxyRequest(proxy.getPort(), `http://${EXFIL_HOST}/x`, { authorization: `Bearer ${token}` });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ error: "egress_refused", reason: "offline_non_loopback" });
    expect(dns.calls).toEqual([]);
    expect(upstreamRequests).toEqual([]);
  });

  it("offline is read from TRENT_OFFLINE when the option is not given", async () => {
    const saved = process.env.TRENT_OFFLINE;
    process.env.TRENT_OFFLINE = "1";
    try {
      const proxy = await startProxy({ lookup: answering([PUBLIC_ADDRESS]).lookup });
      spyUpstream(() => proxy.getPort());
      expect(await rawConnect(proxy.getPort(), `${PUBLIC_HOST}:443`)).toEqual({ status: 403, reason: "offline_non_loopback" });
      expect(upstreamRequests).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.TRENT_OFFLINE;
      else process.env.TRENT_OFFLINE = saved;
    }
  });

  it("online: the same public answer is still dialled at its pinned address (behaviour unchanged)", async () => {
    const dns = answering([PUBLIC_ADDRESS]);
    const decisions: EgressDecision[] = [];
    const proxy = await startProxy({ offline: false, lookup: dns.lookup }, decisions);
    spyUpstream(() => proxy.getPort());
    const res = await proxyRequest({
      proxyPort: proxy.getPort(), host: PUBLIC_HOST, path: "/v1/online",
      headers: { authorization: `Bearer ${token}` }, caPem: proxyCa.getCertPem(),
    });
    expect(res.connectStatus).toBe(200);
    expect(res.status).toBe(502); // the spy's fake upstream failed; the point is that it was asked for
    expect(upstreamRequests).toHaveLength(1);
    expect(upstreamRequests[0]).toMatchObject({ host: PUBLIC_ADDRESS, servername: PUBLIC_HOST });
    expect(dns.calls).toEqual([PUBLIC_HOST]);
    expect(decisions.some((d) => d.rule === "offline_non_loopback")).toBe(false);
  });
});

describe("[O-03] offlineInterceptDomains — the allowlist a proxy is started with", () => {
  it("collapses to LOOPBACK_ALLOWLIST offline and keeps the configured list online", () => {
    const configured = ["api.openai.com", "api.anthropic.com"];
    expect(offlineInterceptDomains(configured, { TRENT_OFFLINE: "1" })).toEqual([...LOOPBACK_ALLOWLIST]);
    expect(offlineInterceptDomains(undefined, { TRENT_OFFLINE: "1" })).toEqual([...LOOPBACK_ALLOWLIST]);
    expect(offlineInterceptDomains(configured, {})).toBe(configured);
    expect(offlineInterceptDomains(undefined, {})).toBeUndefined();
  });
});
