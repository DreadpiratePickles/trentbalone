/**
 * The differentiator tests. Hermes has no egress credential isolation at all; these assert that
 * Trent's proxy actually mediates TLS bodies, refuses by default, and never lets a real secret
 * reach the sandbox.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CertificateAuthority } from "./CertificateAuthority.js";
import { TokenManager } from "./TokenManager.js";
import { EgressProxy } from "./EgressProxy.js";
import { buildSandboxEnv } from "./SandboxEnvironment.js";
import { proxyRequest, type RecordedRequest, type RecordingUpstream } from "./test-helpers.js";

const REAL_SECRET = "sk-real-upstream-secret-value-0001";
const ALLOWED_HOST = "api.openai.com";
const DENIED_HOST = "evil.example.com";

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A throwaway HTTPS server that records every request it receives. */
async function startRecordingUpstream(
  certPem: string,
  keyPem: string
): Promise<RecordingUpstream> {
  const requests: RecordedRequest[] = [];
  const server = https.createServer({ cert: certPem, key: keyPem }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, seen: requests.length }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("EgressProxy — TLS interception and credential brokering", () => {
  let upstreamCa: CertificateAuthority;
  let upstream: RecordingUpstream;
  let proxyCa: CertificateAuthority;
  let proxy: EgressProxy;
  let tokens: TokenManager;
  let caDir: string;
  let tokenDir: string;

  beforeAll(async () => {
    caDir = tmpDir("trent-ca-");
    tokenDir = tmpDir("trent-tok-");

    // The throwaway upstream gets its own private CA so nothing depends on the machine trust store.
    upstreamCa = new CertificateAuthority({ dir: tmpDir("trent-upstream-ca-") });
    const leaf = upstreamCa.issueLeaf(ALLOWED_HOST);
    upstream = await startRecordingUpstream(leaf.certPem, leaf.keyPem);

    proxyCa = new CertificateAuthority({ dir: caDir });
    tokens = new TokenManager({ filePath: path.join(tokenDir, "tokens.json") });
    proxy = new EgressProxy({
      port: 0,
      ca: proxyCa,
      tokenManager: tokens,
      interceptDomains: [ALLOWED_HOST],
      upstreamCa: [upstreamCa.getCertPem()],
      upstreamOverrides: { [ALLOWED_HOST]: { host: "127.0.0.1", port: upstream.port } },
    });
    await proxy.start();
  });

  afterAll(async () => {
    await proxy.stop();
    await upstream.close();
    fs.rmSync(caDir, { recursive: true, force: true });
    fs.rmSync(tokenDir, { recursive: true, force: true });
  });

  it("completes an HTTPS request end to end through the intercepting tunnel", async () => {
    const token = tokens.issueToken("eng-ai-engineer", { apiKey: REAL_SECRET });
    const before = upstream.requests.length;

    const res = await proxyRequest({
      proxyPort: proxy.getPort(),
      host: ALLOWED_HOST,
      path: "/v1/chat/completions",
      method: "POST",
      body: JSON.stringify({ model: "gpt-4o" }),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      caPem: proxyCa.getCertPem(),
    });

    expect(res.connectStatus).toBe(200);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
    expect(upstream.requests.length).toBe(before + 1);

    const seen = upstream.requests[upstream.requests.length - 1]!;
    expect(seen.url).toBe("/v1/chat/completions");
    expect(seen.body).toContain("gpt-4o");
    // The boundary swapped the opaque token for the real secret.
    expect(seen.headers.authorization).toBe(`Bearer ${REAL_SECRET}`);
  });

  it("REFUSES an unauthenticated request and the upstream never sees it", async () => {
    const before = upstream.requests.length;

    const res = await proxyRequest({
      proxyPort: proxy.getPort(),
      host: ALLOWED_HOST,
      path: "/v1/models",
      caPem: proxyCa.getCertPem(),
    });

    expect(res.connectStatus).toBe(200);
    expect(res.status).toBe(407);
    expect(upstream.requests.length).toBe(before);
  });

  it("REFUSES a request bearing an unknown token and never forwards it", async () => {
    const before = upstream.requests.length;

    const res = await proxyRequest({
      proxyPort: proxy.getPort(),
      host: ALLOWED_HOST,
      path: "/v1/models",
      headers: { authorization: "Bearer trnt_egress_ffffffffffffffffffffffffffffffff" },
      caPem: proxyCa.getCertPem(),
    });

    expect(res.status).toBe(407);
    expect(upstream.requests.length).toBe(before);
  });

  it("refuses a host outside intercept_domains at the CONNECT handshake", async () => {
    const before = upstream.requests.length;
    const token = tokens.issueToken("eng-ai-engineer", { apiKey: REAL_SECRET });

    const res = await proxyRequest({
      proxyPort: proxy.getPort(),
      host: DENIED_HOST,
      path: "/",
      headers: { authorization: `Bearer ${token}` },
      caPem: proxyCa.getCertPem(),
    });

    expect(res.connectStatus).toBe(403);
    expect(res.status).toBeNull();
    expect(upstream.requests.length).toBe(before);
  });

  it("stops honouring a token the moment it is revoked", async () => {
    const token = tokens.issueToken("eng-ai-engineer", { apiKey: REAL_SECRET });
    const first = await proxyRequest({
      proxyPort: proxy.getPort(),
      host: ALLOWED_HOST,
      path: "/v1/models",
      headers: { authorization: `Bearer ${token}` },
      caPem: proxyCa.getCertPem(),
    });
    expect(first.status).toBe(200);

    tokens.revokeToken(token);
    const before = upstream.requests.length;

    const second = await proxyRequest({
      proxyPort: proxy.getPort(),
      host: ALLOWED_HOST,
      path: "/v1/models",
      headers: { authorization: `Bearer ${token}` },
      caPem: proxyCa.getCertPem(),
    });
    expect(second.status).toBe(407);
    expect(upstream.requests.length).toBe(before);
  });

  it("fails closed when intercept_domains is empty", async () => {
    const bare = new EgressProxy({
      port: 0,
      ca: proxyCa,
      tokenManager: tokens,
      interceptDomains: [],
    });
    await bare.start();
    try {
      const token = tokens.issueToken("ceo", { apiKey: REAL_SECRET });
      const res = await proxyRequest({
        proxyPort: bare.getPort(),
        host: ALLOWED_HOST,
        path: "/v1/models",
        headers: { authorization: `Bearer ${token}` },
        caPem: proxyCa.getCertPem(),
      });
      expect(res.connectStatus).toBe(403);
    } finally {
      await bare.stop();
    }
  });

  it("never places the real secret in the sandbox environment", () => {
    const token = tokens.issueToken("eng-ai-engineer", { apiKey: REAL_SECRET });
    const env = buildSandboxEnv({
      token,
      proxyUrl: `http://127.0.0.1:${proxy.getPort()}`,
      caCertPath: "/etc/trent/ca.crt",
      credentialEnvNames: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
      base: { PATH: "/usr/bin" },
    });

    expect(env.OPENAI_API_KEY).toBe(token);
    expect(env.ANTHROPIC_API_KEY).toBe(token);
    expect(env.HTTPS_PROXY).toContain("127.0.0.1");
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/etc/trent/ca.crt");
    for (const [key, value] of Object.entries(env)) {
      expect(`${key}=${value}`).not.toContain(REAL_SECRET);
    }
    expect(JSON.stringify(env)).not.toContain(REAL_SECRET);
  });
});
