/**
 * The broker's secret goes only to the host it was minted for, end to end over loopback.
 *
 * Fake HTTPS upstreams on 127.0.0.1 stand in for two model providers (OpenAI, Gemini), a business
 * API and a search API the owner also allowlisted. Before host binding, a sandboxed plain fetch to
 * any of them carrying the proxy token had the profile's provider key written onto it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CertificateAuthority } from "./CertificateAuthority.js";
import { OWN_CREDENTIAL_HEADER } from "./CredentialBroker.js";
import { EgressProxy } from "./EgressProxy.js";
import { TokenManager } from "./TokenManager.js";
import { proxyRequest, startRecordingUpstream, type RecordedRequest, type RecordingUpstream } from "./test-helpers.js";

const PROVIDER_KEY = "fake-provider-key-for-host-binding-0001";
const OPENAI = "api.openai.com";
const GEMINI = "generativelanguage.googleapis.com";
const BUSINESS = "api.business.example";
const SEARCH = "api.tavily.com";
const HOSTS = [OPENAI, GEMINI, BUSINESS, SEARCH];
const CREDENTIAL_HEADERS = ["authorization", "x-api-key", "x-goog-api-key", "x-trent-proxy-token"];

const dirs: string[] = [];
function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function withheldLines(lines: readonly string[]): Array<Record<string, unknown>> {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((record) => record.event === "egress.secret_withheld");
}

/** No credential header at all, and neither the key nor the token anywhere in the headers. */
function expectBare(request: RecordedRequest, token: string): void {
  for (const name of CREDENTIAL_HEADERS) expect(request.headers[name], name).toBeUndefined();
  expect(JSON.stringify(request.headers)).not.toContain(PROVIDER_KEY);
  expect(JSON.stringify(request.headers)).not.toContain(token);
}

describe("EgressProxy — a brokered secret is bound to its host", () => {
  const upstreams = new Map<string, RecordingUpstream>();
  let proxyCa: CertificateAuthority;
  let proxy: EgressProxy;
  let tokens: TokenManager;
  const logLines: string[] = [];

  beforeAll(async () => {
    const upstreamCa = new CertificateAuthority({ dir: tmpDir("trent-hb-upstream-ca-") });
    for (const host of HOSTS) {
      const leaf = upstreamCa.issueLeaf(host);
      upstreams.set(host, await startRecordingUpstream(leaf.certPem, leaf.keyPem));
    }
    proxyCa = new CertificateAuthority({ dir: tmpDir("trent-hb-ca-") });
    tokens = new TokenManager({ ephemeral: true });
    proxy = new EgressProxy({
      port: 0,
      ca: proxyCa,
      tokenManager: tokens,
      interceptDomains: HOSTS,
      upstreamCa: [upstreamCa.getCertPem()],
      upstreamOverrides: Object.fromEntries(HOSTS.map((host) => [host, { host: "127.0.0.1", port: upstreams.get(host)!.port }])),
      log: (line: string) => void logLines.push(line),
    });
    await proxy.start();
  });

  afterAll(async () => {
    await proxy.stop();
    for (const upstream of upstreams.values()) await upstream.close();
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  async function send(host: string, headers: Record<string, string>): Promise<RecordedRequest> {
    const upstream = upstreams.get(host)!;
    const before = upstream.requests.length;
    const res = await proxyRequest({ proxyPort: proxy.getPort(), host, path: "/v1/things", headers, caPem: proxyCa.getCertPem() });
    // Forwarded, not refused: the host is allowlisted and the token is valid; only the secret is withheld.
    expect(res.status).toBe(200);
    expect(upstream.requests.length).toBe(before + 1);
    return upstream.requests.at(-1)!;
  }

  it("the provider host receives the key; another allowlisted host receives the request with no credential; one withheld line names it", async () => {
    const token = tokens.issueToken("trent-repl", { apiKey: PROVIDER_KEY }, "repl", { hosts: [OPENAI] });
    logLines.length = 0;

    expect((await send(OPENAI, { authorization: `Bearer ${token}` })).headers.authorization).toBe(`Bearer ${PROVIDER_KEY}`);
    expectBare(await send(BUSINESS, { authorization: `Bearer ${token}` }), token);
    // A second request to the same host: still bare, and still ONE line for it.
    expectBare(await send(BUSINESS, { authorization: `Bearer ${token}` }), token);

    const withheld = withheldLines(logLines);
    expect(withheld).toHaveLength(1);
    expect(withheld[0]).toMatchObject({ level: "warn", host: BUSINESS, port: 443, reason: "host_not_bound", boundHosts: [OPENAI] });
    expect(logLines.join("\n")).not.toContain(PROVIDER_KEY);
    expect(logLines.join("\n")).not.toContain(token);
  });

  it("on a Gemini profile, a sandboxed script using OPENAI_API_KEY (the token) against api.openai.com sends OpenAI no key", async () => {
    const token = tokens.issueToken("trent-repl", { apiKey: PROVIDER_KEY }, "repl", { hosts: [GEMINI] });
    expectBare(await send(OPENAI, { authorization: `Bearer ${token}` }), token);
    expect((await send(GEMINI, { "x-goog-api-key": token })).headers["x-goog-api-key"]).toBe(PROVIDER_KEY);
  });

  it("a search call carrying its own key reaches the search host with that key intact and no model key", async () => {
    const token = tokens.issueToken("trent-repl", { apiKey: PROVIDER_KEY }, "repl", { hosts: [OPENAI] });
    const seen = await send(SEARCH, { authorization: "Bearer tvly-fake-caller-key", "x-trent-proxy-token": token });
    expect(seen.headers.authorization).toBe("Bearer tvly-fake-caller-key");
    expect(seen.headers["x-trent-proxy-token"]).toBeUndefined();
    expect(JSON.stringify(seen.headers)).not.toContain(PROVIDER_KEY);
    expect(JSON.stringify(seen.headers)).not.toContain(token);
  });

  it("a launched-browser-style request (the token as an extra header on every request) reaches a non-provider host with neither the token nor a credential", async () => {
    const token = tokens.issueToken("trent-repl", { apiKey: PROVIDER_KEY }, "repl", { hosts: [OPENAI] });
    const seen = await send(BUSINESS, { "x-trent-proxy-token": token, "user-agent": "Mozilla/5.0 (fake launched browser)", accept: "text/html" });
    expectBare(seen, token);
    expect(seen.headers["user-agent"]).toBe("Mozilla/5.0 (fake launched browser)");
  });

  it("a legacy token with no host binding forwards to the provider host with NO key, and says why", async () => {
    const legacy = tokens.issueToken("trent-repl", { apiKey: PROVIDER_KEY }, "repl");
    logLines.length = 0;

    expectBare(await send(OPENAI, { authorization: `Bearer ${legacy}` }), legacy);

    const withheld = withheldLines(logLines);
    expect(withheld).toHaveLength(1);
    expect(withheld[0]).toMatchObject({ host: OPENAI, reason: "no_host_binding" });
    expect(logLines.join("\n")).not.toContain(PROVIDER_KEY);
    expect(logLines.join("\n")).not.toContain(legacy);
  });

  it("the own-credential marker to a BOUND host still carries only the caller's credential, and nothing is logged as withheld", async () => {
    const token = tokens.issueToken("trent-repl", { apiKey: PROVIDER_KEY }, "repl", { hosts: [OPENAI] });
    logLines.length = 0;

    const seen = await send(OPENAI, { authorization: "Bearer caller-own-bearer", "x-trent-proxy-token": token, [OWN_CREDENTIAL_HEADER]: "1" });
    expect(seen.headers.authorization).toBe("Bearer caller-own-bearer");
    expect(JSON.stringify(seen.headers)).not.toContain(PROVIDER_KEY);
    expect(JSON.stringify(seen.headers)).not.toContain(token);
    expect(withheldLines(logLines)).toHaveLength(0);
  });
});
