/**
 * [D3] DNS rebinding / resolve-then-connect on the online egress proxy.
 *
 * The property this suite pins: the proxy resolves an allowlisted host exactly ONCE, validates every
 * address that one answer holds, and connects to that exact address — never re-resolving between the
 * check and the connect. A DNS name must resolve to public space (a `*.localhost` name to loopback);
 * a private, loopback, link-local or cloud-metadata answer is refused with 403 and no upstream socket
 * is opened. SNI and the Host header stay the hostname, so TLS verification is unchanged.
 *
 * Every lookup here is an injected rebinding resolver: it answers the first query with one address
 * and every later query with another. No real DNS is consulted by the proxy under test.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { CertificateAuthority } from "./CertificateAuthority.js";
import { TokenManager } from "./TokenManager.js";
import { EgressProxy } from "./EgressProxy.js";
import { proxyRequest, startRecordingUpstream, type RecordingUpstream } from "./test-helpers.js";
import type { LookupFn } from "../tools/web/url-safety.js";

const PINNED_HOST = "svc.localhost"; // a localhost name: must resolve to loopback
const PUBLIC_HOST = "api.rebind.test"; // a DNS name: must resolve to public space

/** A resolver that answers `first` on the first query and `later` on every query after it. */
function rebinding(first: string[], later: string[]): { lookup: LookupFn; calls: string[] } {
  const calls: string[] = [];
  const lookup: LookupFn = async (host) => {
    calls.push(host);
    const answer = calls.length === 1 ? first : later;
    return answer.map((address) => ({ address, family: net.isIPv6(address) ? 6 : 4 }));
  };
  return { lookup, calls };
}

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A plain-HTTP upstream on 127.0.0.1 that records the Host header of every request it gets. */
async function startPlainUpstream(): Promise<{ port: number; hosts: string[]; close(): Promise<void> }> {
  const hosts: string[] = [];
  const server = http.createServer((req, res) => {
    hosts.push(String(req.headers.host));
    req.resume();
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("plain-ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { port, hosts, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** One absolute-form plain-HTTP request through the proxy, as a sandboxed client would send it. */
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

describe("[D3] EgressProxy — one resolution for the check and the connect", () => {
  let upstreamCa: CertificateAuthority;
  let upstream: RecordingUpstream;
  let plain: Awaited<ReturnType<typeof startPlainUpstream>>;
  let proxyCa: CertificateAuthority;
  let tokens: TokenManager;
  let token: string;
  const dirs: string[] = [];
  const proxies: EgressProxy[] = [];

  beforeAll(async () => {
    const [upDir, caDir, tokDir] = [tmpDir("trent-d3-up-"), tmpDir("trent-d3-ca-"), tmpDir("trent-d3-tok-")];
    dirs.push(upDir, caDir, tokDir);
    upstreamCa = new CertificateAuthority({ dir: upDir });
    const leaf = upstreamCa.issueLeaf(PINNED_HOST); // the upstream cert names the HOST, not the IP
    upstream = await startRecordingUpstream(leaf.certPem, leaf.keyPem);
    plain = await startPlainUpstream();
    proxyCa = new CertificateAuthority({ dir: caDir });
    tokens = new TokenManager({ filePath: path.join(tokDir, "tokens.json") });
    token = tokens.issueToken("eng-d3", { apiKey: "sk-d3-upstream-secret-0000" }, undefined, { hosts: [PINNED_HOST, PUBLIC_HOST] });
  });

  afterAll(async () => {
    for (const p of proxies) await p.stop();
    await upstream.close();
    await plain.close();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  async function startProxy(lookup: LookupFn): Promise<EgressProxy> {
    const proxy = new EgressProxy({
      port: 0,
      ca: proxyCa,
      tokenManager: tokens,
      interceptDomains: [PINNED_HOST, PUBLIC_HOST],
      upstreamCa: [upstreamCa.getCertPem()],
      lookup,
      log: () => {},
    });
    await proxy.start();
    proxies.push(proxy);
    return proxy;
  }

  it("CONNECT: dials the first, validated answer once, keeping SNI and Host as the hostname", async () => {
    const dns = rebinding(["127.0.0.1"], ["192.0.2.1"]);
    const proxy = await startProxy(dns.lookup);
    const before = upstream.requests.length;
    const res = await proxyRequest({
      proxyPort: proxy.getPort(), host: PINNED_HOST, port: upstream.port, path: "/v1/pinned",
      headers: { authorization: `Bearer ${token}` }, caPem: proxyCa.getCertPem(),
    });
    expect(res.status).toBe(200); // TLS verified against the hostname while the socket went to the IP
    expect(dns.calls).toEqual([PINNED_HOST]); // exactly one resolution: no second query to rebind
    expect(upstream.requests.length).toBe(before + 1);
    expect(upstream.requests.at(-1)?.headers.host).toBe(PINNED_HOST);
  });

  it("plain HTTP: dials the first, validated answer once, keeping the Host header", async () => {
    const dns = rebinding(["127.0.0.1"], ["192.0.2.1"]);
    const proxy = await startProxy(dns.lookup);
    const res = await plainProxyRequest(proxy.getPort(), `http://${PINNED_HOST}:${plain.port}/x`, { authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);
    expect(res.body).toBe("plain-ok");
    expect(dns.calls).toEqual([PINNED_HOST]);
    expect(plain.hosts.at(-1)).toMatch(/^svc\.localhost/);
  });

  for (const address of ["169.254.169.254", "127.0.0.1", "10.1.2.3", "192.168.0.7", "fe80::1"]) {
    it(`refuses an allowlisted public name that resolves to ${address}, opening no upstream socket`, async () => {
      // the reverse rebind: the only answer the proxy ever sees is the private one
      const dns = rebinding([address], ["203.0.113.9"]);
      const proxy = await startProxy(dns.lookup);
      const before = plain.hosts.length;
      const res = await plainProxyRequest(proxy.getPort(), `http://${PUBLIC_HOST}:${plain.port}/x`, { authorization: `Bearer ${token}` });
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body)).toMatchObject({ error: "egress_refused", reason: "resolved_address_not_permitted" });
      expect(dns.calls).toEqual([PUBLIC_HOST]);
      expect(plain.hosts.length).toBe(before);
    });
  }

  it("refuses when ANY address in the one answer is private (a mixed answer cannot smuggle loopback)", async () => {
    const dns = rebinding(["203.0.113.9", "127.0.0.1"], ["203.0.113.9"]);
    const proxy = await startProxy(dns.lookup);
    const before = upstream.requests.length;
    const res = await proxyRequest({
      proxyPort: proxy.getPort(), host: PUBLIC_HOST, port: upstream.port, path: "/v1/mixed",
      headers: { authorization: `Bearer ${token}` }, caPem: proxyCa.getCertPem(),
    });
    expect(res.status).toBe(403);
    expect(upstream.requests.length).toBe(before);
  });

  it("refuses a localhost name that resolves off the machine", async () => {
    const dns = rebinding(["203.0.113.9"], ["127.0.0.1"]);
    const proxy = await startProxy(dns.lookup);
    const res = await plainProxyRequest(proxy.getPort(), `http://${PINNED_HOST}:${plain.port}/x`, { authorization: `Bearer ${token}` });
    expect(res.status).toBe(403);
    expect(dns.calls).toEqual([PINNED_HOST]);
  });

  it("resolves nothing for a request that fails the token gate", async () => {
    const dns = rebinding(["127.0.0.1"], ["127.0.0.1"]);
    const proxy = await startProxy(dns.lookup);
    const res = await plainProxyRequest(proxy.getPort(), `http://${PINNED_HOST}:${plain.port}/x`, {});
    expect(res.status).toBe(407);
    expect(dns.calls).toEqual([]);
  });
});
