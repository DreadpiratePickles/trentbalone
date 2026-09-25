/**
 * The one real launch: a Chromium found on this machine, driven through a REAL EgressProxy to a
 * throwaway HTTPS upstream. The upstream is reachable only through the proxy's `upstreamOverrides`
 * (the hostname resolves nowhere), so a recorded request proves the tunnel was the path taken and
 * that the broker stripped the opaque token before forwarding.
 *
 * Skipped, not passed, when no Chromium is installed. The two navigating tests carry a runner-sized
 * timeout and one retry: on shared CI runners the first Chromium launch through the TLS proxy has
 * exceeded 60 s once and the runner's network changed under a request once. The retry inside
 * `navigate` covers the second case for users; the test retry covers the first for CI.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { CertificateAuthority } from "../../egress/CertificateAuthority.js";
import { EgressProxy } from "../../egress/EgressProxy.js";
import { TokenManager } from "../../egress/TokenManager.js";
import { findChromium } from "./chromium.js";
import { createBrowserAdapter } from "./index.js";

const HOST = "browser-test.example";
const PUBLIC_LOOKUP = async () => [{ address: "93.184.216.34", family: 4 }];
const chromiumPath = findChromium(process.env);
if (!chromiumPath) console.error("[browser.chromium] SKIPPED: no Chromium found. A skip is NOT a pass.");

interface Seen { host?: string; token?: string; url?: string }

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe.skipIf(!chromiumPath)("browser toolset (real Chromium through a real EgressProxy)", () => {
  const seen: Seen[] = [];
  let upstream: https.Server;
  let proxy: EgressProxy;
  let token: string;
  let profileDir: string;
  let adapter: ReturnType<typeof createBrowserAdapter>;

  beforeAll(async () => {
    const upstreamCa = new CertificateAuthority({ dir: tmp("trent-bup-ca-") });
    const leaf = upstreamCa.issueLeaf(HOST);
    upstream = https.createServer({ cert: leaf.certPem, key: leaf.keyPem }, (req, res) => {
      const rawToken = req.headers["x-trent-proxy-token"];
      seen.push({ host: req.headers.host, token: Array.isArray(rawToken) ? rawToken[0] : rawToken, url: req.url });
      res.writeHead(200, { "content-type": "text/html" });
      res.end('<html><head><title>Proxied Page</title></head><body><h1>Through the tunnel</h1><a href="/next" id="go">Next</a><input name="q" placeholder="Search"></body></html>');
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const proxyCa = new CertificateAuthority({ dir: tmp("trent-bproxy-ca-") });
    const tokens = new TokenManager({ filePath: path.join(tmp("trent-btok-"), "tokens.json") });
    token = tokens.issueToken("browser-test", {}, "browser");
    proxy = new EgressProxy({
      port: 0,
      ca: proxyCa,
      tokenManager: tokens,
      interceptDomains: [HOST],
      upstreamCa: [upstreamCa.getCertPem()],
      upstreamOverrides: { [HOST]: { host: "127.0.0.1", port } },
    });
    await proxy.start();

    profileDir = tmp("trent-bprofile-");
    adapter = createBrowserAdapter({
      profileDir,
      runId: "run_chromium",
      executablePath: chromiumPath,
      lookup: PUBLIC_LOOKUP,
      egress: { proxyUrl: `http://127.0.0.1:${proxy.getPort()}`, token, caPem: proxyCa.getCertPem() },
    });
  }, 60_000);

  afterAll(async () => {
    await adapter?.cleanup();
    await proxy?.stop();
    await new Promise<void>((resolve) => upstream?.close(() => resolve()));
    if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true });
  });

  it("navigates through the proxy tunnel, and the broker strips the token before the upstream", async () => {
    const result = await adapter.execute(`browser_navigate {"url":"https://${HOST}/"}`, {});
    expect(result.status, result.summary).toBe("completed");
    expect(result.summary).toContain("Proxied Page");
    expect(result.summary).toMatch(/@e\d+/);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]?.host).toBe(HOST);
    expect(seen[0]?.token).toBeUndefined();
  }, { timeout: 120_000, retry: 1 });

  it("reads the page text and writes a real PNG under the profile", async () => {
    const text = await adapter.execute("browser_get_text {}", {});
    expect(text.status).toBe("completed");
    expect(text.summary).toContain("Through the tunnel");
    const shot = await adapter.execute("browser_screenshot {}", {});
    expect(shot.status, shot.summary).toBe("completed");
    const file = /(\S+\.png)/.exec(shot.summary)?.[1];
    expect(file?.startsWith(path.join(profileDir, "browser", "run_chromium"))).toBe(true);
    const head = fs.readFileSync(file!).subarray(0, 4);
    expect([...head]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  }, { timeout: 120_000, retry: 1 });

  it("refuses a host the proxy does not allowlist, so the browser cannot leave the tunnel", async () => {
    const result = await adapter.execute('browser_navigate {"url":"https://not-allowlisted.example/"}', {});
    expect(result.status).not.toBe("completed");
    expect(seen.every((s) => s.host === HOST)).toBe(true);
  }, 60_000);
});
