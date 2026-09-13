/**
 * web_search / web_extract: Hermes's names and schemas, fetched through Trent's egress proxy.
 * Every network test runs against a throwaway HTTPS upstream behind a real EgressProxy instance,
 * so "the proxy saw the CONNECT" is asserted on the actual tunnel, not a mock.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { CertificateAuthority } from "../../egress/CertificateAuthority.js";
import { TokenManager } from "../../egress/TokenManager.js";
import { EgressProxy } from "../../egress/EgressProxy.js";
import { createWebToolsAdapter, WEB_TOOL_SCHEMAS } from "./index.js";
import { checkUrlSafety } from "./url-safety.js";
import { SUMMARY_LIMIT } from "../spillover.js";

const JINA = "r.jina.ai";
const TAVILY = "api.tavily.com";
const PUBLIC_LOOKUP = async () => [{ address: "93.184.216.34", family: 4 }];

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

interface Upstream { port: number; urls: string[]; bodies: string[]; close(): Promise<void> }

async function startUpstream(certPem: string, keyPem: string): Promise<Upstream> {
  const urls: string[] = [];
  const bodies: string[] = [];
  const server = https.createServer({ cert: certPem, key: keyPem }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = req.url ?? "";
      urls.push(url);
      bodies.push(Buffer.concat(chunks).toString("utf8"));
      if (url === "/search") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          answer: "Example is a reserved domain.",
          results: [
            { title: "Example Domain", url: "https://example.com", content: "This domain is for use in examples.", score: 0.9 },
            { title: "IANA", url: "https://iana.org/domains/reserved", content: "Reserved domains.", score: 0.5 },
          ],
        }));
        return;
      }
      if (url.includes("redirect-me")) {
        res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
        res.end();
        return;
      }
      if (url.includes("huge")) {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(`HEAD-MARK ${"h".repeat(30_000)} TAIL-MARK`);
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("Title: Example Domain\n\nThis domain is for use in illustrative examples in documents.");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : 0,
    urls,
    bodies,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("web toolset through the egress proxy", () => {
  let proxy: EgressProxy;
  let upstream: Upstream;
  let searchUpstream: Upstream;
  let proxyCa: CertificateAuthority;
  let token: string;
  let dirs: string[] = [];
  let profileDir: string;

  beforeAll(async () => {
    const upstreamCa = new CertificateAuthority({ dir: tmp("trent-web-up-ca-") });
    const leaf = upstreamCa.issueLeaf(JINA);
    upstream = await startUpstream(leaf.certPem, leaf.keyPem);
    const tavilyLeaf = upstreamCa.issueLeaf(TAVILY);
    searchUpstream = await startUpstream(tavilyLeaf.certPem, tavilyLeaf.keyPem);
    proxyCa = new CertificateAuthority({ dir: tmp("trent-web-ca-") });
    const tokDir = tmp("trent-web-tok-");
    profileDir = tmp("trent-web-profile-");
    dirs = [tokDir, profileDir];
    const tokens = new TokenManager({ filePath: path.join(tokDir, "tokens.json") });
    token = tokens.issueToken("seat", { apiKey: "real-provider-secret" });
    proxy = new EgressProxy({
      port: 0,
      ca: proxyCa,
      tokenManager: tokens,
      interceptDomains: [JINA, TAVILY],
      upstreamCa: [upstreamCa.getCertPem()],
      upstreamOverrides: {
        [JINA]: { host: "127.0.0.1", port: upstream.port },
        [TAVILY]: { host: "127.0.0.1", port: searchUpstream.port },
      },
    });
    await proxy.start();
  });

  afterAll(async () => {
    await proxy.stop();
    await upstream.close();
    await searchUpstream.close();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  function adapter(env: Record<string, string> = {}) {
    return createWebToolsAdapter({
      profileDir,
      env: { TAVILY_API_KEY: token, ...env },
      egress: { proxyUrl: `http://127.0.0.1:${proxy.getPort()}`, caPem: proxyCa.getCertPem(), token },
      lookup: PUBLIC_LOOKUP,
    });
  }

  it("web_extract returns Example Domain text and the proxy tunnelled the CONNECT", async () => {
    const before = upstream.urls.length;
    const rec = await adapter().execute('web_extract {"urls":["https://example.com"]}', {});
    expect(rec.status).toBe("completed");
    expect(rec.summary).toContain("Example Domain");
    expect(upstream.urls.length).toBe(before + 1);
    expect(upstream.urls[upstream.urls.length - 1]).toBe("/https://example.com");
  });

  it("a reader host outside intercept_domains yields the proxy's 403 in the summary", async () => {
    const strict = new EgressProxy({
      port: 0,
      ca: proxyCa,
      tokenManager: proxy.getTokenManager(),
      interceptDomains: [TAVILY],
    });
    await strict.start();
    try {
      const a = createWebToolsAdapter({
        profileDir,
        env: { TAVILY_API_KEY: token },
        egress: { proxyUrl: `http://127.0.0.1:${strict.getPort()}`, caPem: proxyCa.getCertPem(), token },
        lookup: PUBLIC_LOOKUP,
      });
      const rec = await a.execute('web_extract {"urls":["https://example.com"]}', {});
      expect(rec.status).toBe("failed");
      expect(rec.summary).toMatch(/403/);
      expect(rec.summary).toContain("host_not_allowlisted");
    } finally {
      await strict.stop();
    }
  });

  it("blocks the cloud metadata IP before any socket opens", async () => {
    let connections = 0;
    const listener = net.createServer((s) => { connections += 1; s.destroy(); });
    await new Promise<void>((r) => listener.listen(0, "127.0.0.1", r));
    const port = (listener.address() as net.AddressInfo).port;
    try {
      const a = createWebToolsAdapter({
        profileDir,
        env: { TAVILY_API_KEY: token },
        egress: { proxyUrl: `http://127.0.0.1:${port}`, caPem: proxyCa.getCertPem(), token },
      });
      const rec = await a.execute('web_extract {"urls":["http://169.254.169.254/latest/meta-data/"]}', {});
      expect(rec.status).toBe("blocked");
      expect(rec.summary).toMatch(/metadata/i);
      expect(connections).toBe(0);
    } finally {
      await new Promise<void>((r) => listener.close(() => r()));
    }
  });

  it("re-validates a redirect target and refuses one that lands on a private address", async () => {
    const rec = await adapter().execute('web_extract {"urls":["https://example.com/redirect-me"]}', {});
    expect(rec.status).not.toBe("completed");
    expect(rec.summary).toMatch(/redirect/i);
    expect(rec.summary).toMatch(/169\.254\.169\.254|metadata|blocked/i);
  });

  it("applies the 15K default with a 75/25 head/tail split and spills the full text", async () => {
    const rec = await adapter().execute('web_extract {"urls":["https://example.com/huge"]}', {});
    expect(rec.status).toBe("completed");
    expect(rec.summary).toContain("HEAD-MARK");
    expect(rec.summary).toContain("TAIL-MARK");
    expect(rec.summary).toMatch(/omitted/);
    expect(rec.summary.length).toBeLessThan(16_500);
    expect(rec.summary).toContain("read_file");
    const m = /saved to (\S+\.txt)/.exec(rec.summary);
    expect(m).not.toBeNull();
    expect(fs.readFileSync(m![1]!, "utf8")).toContain("h".repeat(30_000));
    expect(rec.summary.length).toBeLessThanOrEqual(SUMMARY_LIMIT);
  });

  it("web_search goes through the proxy, honours limit, and lists every result", async () => {
    const before = searchUpstream.bodies.length;
    const rec = await adapter().execute('web_search {"query":"example domain","limit":40}', {});
    expect(rec.status, rec.summary).toBe("completed");
    expect(rec.summary).toContain("https://iana.org/domains/reserved");
    expect(rec.summary).toContain("Example is a reserved domain.");
    const body = JSON.parse(searchUpstream.bodies[before]!) as { max_results: number };
    expect(body.max_results).toBe(40);
    expect(searchUpstream.urls[before]).toBe("/search");
  });

  it("refuses more than 5 urls, a char_limit below 2000, and secret-shaped query strings", async () => {
    const many = JSON.stringify({ urls: ["https://a.com", "https://b.com", "https://c.com", "https://d.com", "https://e.com", "https://f.com"] });
    expect((await adapter().execute(`web_extract ${many}`, {})).status).toBe("failed");
    const rec = await adapter().execute('web_extract {"urls":["https://example.com"],"char_limit":100}', {});
    expect(rec.status).toBe("failed");
    expect(rec.summary).toMatch(/2000/);
    const secret = await adapter().execute('web_extract {"urls":["https://example.com/?access_token=abcdef123456"]}', {});
    expect(secret.status).toBe("blocked");
    expect(secret.summary).toMatch(/secret/i);
  });

  it("healthCheck is needs_credentials without TAVILY_API_KEY", async () => {
    const a = createWebToolsAdapter({
      profileDir,
      env: {},
      egress: { proxyUrl: `http://127.0.0.1:${proxy.getPort()}`, caPem: proxyCa.getCertPem(), token },
    });
    expect(await a.healthCheck()).toBe("needs_credentials");
    expect(await adapter().healthCheck()).toBe("connected");
    expect(a.requiresApproval('web_extract {"urls":["https://x.com"]}')).toBe(false);
  });

  it("exposes the two Hermes schemas as data", () => {
    expect(WEB_TOOL_SCHEMAS.map((s) => s.name)).toEqual(["web_search", "web_extract"]);
    expect(WEB_TOOL_SCHEMAS[1]!.parameters.required).toEqual(["urls"]);
  });
});

describe("url safety floors", () => {
  const lookup = async (host: string) =>
    host === "resolves-private.test" ? [{ address: "10.0.0.5", family: 4 }] : [{ address: "1.1.1.1", family: 4 }];

  it("rejects non-http schemes, private, loopback, link-local, CGNAT and mapped v6", async () => {
    for (const bad of [
      "ftp://example.com/x",
      "file:///etc/passwd",
      "http://127.0.0.1/",
      "http://localhost/",
      "http://10.1.2.3/",
      "http://172.16.0.1/",
      "http://192.168.1.1/",
      "http://100.64.0.1/",
      "http://169.254.1.1/",
      "http://[::1]/",
      "http://[fd00::1]/",
      "http://[::ffff:10.0.0.1]/",
      "http://0.0.0.0/",
      "http://resolves-private.test/",
    ]) {
      const v = await checkUrlSafety(bad, { lookup });
      expect(v.ok, bad).toBe(false);
    }
  });

  it("always blocks cloud metadata endpoints, and passes a public host", async () => {
    const meta = await checkUrlSafety("http://169.254.169.254/latest/meta-data/", { lookup });
    expect(meta.ok).toBe(false);
    if (!meta.ok) expect(meta.reason).toMatch(/metadata/i);
    const v6 = await checkUrlSafety("http://[fd00:ec2::254]/", { lookup });
    expect(v6.ok).toBe(false);
    const ok = await checkUrlSafety("https://example.com/path?q=1", { lookup });
    expect(ok.ok).toBe(true);
  });
});
