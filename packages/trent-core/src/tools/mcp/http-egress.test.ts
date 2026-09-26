/**
 * [H2] RED — where an MCP bearer may go, through the REAL egress proxy with a broker token that carries
 * a credential (the REPL's token carries the model provider key).
 *
 * 1. The OAuth bearer reaches the MCP host and only the MCP host. The token refresh goes to the
 *    authorization server through the proxy with the own-credential marker, so the broker writes no
 *    `Authorization` into it: the authorization server sees neither a bearer nor the model key, and the
 *    MCP host never sees the refresh token.
 * 2. A cross-origin redirect from the MCP server is refused. `createEgressFetch` follows redirects itself
 *    and re-sends every header on every hop, so without the pin a 307 to another allowlisted host hands
 *    that host the bearer: an OAuth one, or a static `Authorization` from the entry (the P2-14 case).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigManager } from "../../config/ConfigManager.js";
import type { McpServerConfig } from "../../config/schema.js";
import { CertificateAuthority } from "../../egress/CertificateAuthority.js";
import { EgressProxy } from "../../egress/EgressProxy.js";
import { TokenManager } from "../../egress/TokenManager.js";
import { AS_HOST, FakeAuthServer, FakeOAuthMcp, LOOKUP, MCP_HOST, fakeBrowser, routingFetch, type FakeOAuthMcpOptions } from "./__fixtures__/fake-oauth-mcp.js";
import { connectMcpServer } from "./client.js";
import { loginMcpServer } from "./http-oauth.js";
import { McpOAuthStore, mcpOAuthEnvNames, mcpOAuthHeaderTemplate } from "./http-oauth-store.js";

const MODEL_KEY = "model-key-fixture-must-never-leave-for-an-mcp-or-auth-host";
const OTHER_HOST = "other.fake.test";

let root: string;
let manager: ConfigManager;
let store: McpOAuthStore;
let as: FakeAuthServer;
let mcp: FakeOAuthMcp;
let other: FakeOAuthMcp;
let proxy: EgressProxy;
let brokerToken: string;

async function setup(mcpOptions: FakeOAuthMcpOptions = {}): Promise<void> {
  as = new FakeAuthServer();
  await as.start();
  mcp = new FakeOAuthMcp(as, mcpOptions);
  await mcp.start();
  other = new FakeOAuthMcp(as);
  await other.start();
  const tokens = new TokenManager({ ephemeral: true });
  proxy = new EgressProxy({
    port: 0,
    ca: new CertificateAuthority({ dir: path.join(root, "ca") }),
    tokenManager: tokens,
    interceptDomains: [MCP_HOST, AS_HOST, OTHER_HOST],
    upstreamOverrides: {
      [MCP_HOST]: { host: "127.0.0.1", port: mcp.port },
      [AS_HOST]: { host: "127.0.0.1", port: as.port },
      [OTHER_HOST]: { host: "127.0.0.1", port: other.port },
    },
  });
  await proxy.start();
  brokerToken = tokens.issueToken("trent-repl", { apiKey: MODEL_KEY }, "repl");
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trent-mcp-oauth-egress-")));
  manager = new ConfigManager({ baseDir: root });
  store = new McpOAuthStore(manager);
});

afterEach(async () => {
  await proxy?.stop();
  await other?.stop();
  await mcp?.stop();
  await as?.stop();
  for (const name of Object.keys(process.env)) if (name.startsWith("MCP_FAKE_")) delete process.env[name];
  fs.rmSync(root, { recursive: true, force: true });
});

function entry(headers: Record<string, string>): McpServerConfig {
  return { transport: "http", url: mcp.url, headers, auto_approve: [], enabled: true };
}

function viaProxy(config: McpServerConfig, env: NodeJS.ProcessEnv = {}, now?: () => Date) {
  return connectMcpServer("fake", config, {
    env,
    egress: { proxyUrl: `http://127.0.0.1:${proxy.getPort()}`, token: brokerToken },
    lookup: LOOKUP,
    oauth: { store, ...(now === undefined ? {} : { now }) },
    redactionLog: () => undefined,
  });
}

describe("an OAuth MCP bearer through the egress proxy", () => {
  it("reaches only the MCP host; the refresh reaches the authorization server with no bearer and no model key", async () => {
    await setup();
    const routes = { [AS_HOST]: as.port, [MCP_HOST]: mcp.port };
    await loginMcpServer("fake", mcp.url, { store, fetchImpl: routingFetch(routes), lookup: LOOKUP, openBrowser: (url) => void fakeBrowser(url, routes), timeoutMs: 5000 });
    const asBefore = as.requests.length;
    const mcpBefore = mcp.requests.length;

    const later = () => new Date(Date.now() + 2 * 3600_000);
    const connection = await viaProxy(entry({ Authorization: mcpOAuthHeaderTemplate("fake") }), {}, later);
    expect((await connection.callTool("echo", { text: "hi" })).text).toBe("echo: hi");
    await connection.close();

    const refreshed = as.issued.accessTokens[1]!;
    const toMcp = mcp.requests.slice(mcpBefore);
    expect(toMcp.length).toBeGreaterThan(2);
    for (const request of toMcp) {
      expect(request.headers.authorization, request.path).toBe(`Bearer ${refreshed}`);
      const all = JSON.stringify(request.headers) + request.body;
      expect(all).not.toContain(MODEL_KEY);
      expect(all).not.toContain(brokerToken);
      for (const refresh of as.issued.refreshTokens) expect(all).not.toContain(refresh);
      expect(request.headers["x-trent-own-credential"]).toBeUndefined();
    }

    const toAs = as.requests.slice(asBefore);
    expect(toAs.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /token"]);
    for (const request of toAs) {
      expect(request.headers.authorization).toBeUndefined();
      const all = JSON.stringify(request.headers) + request.body;
      expect(all).not.toContain(MODEL_KEY);
      expect(all).not.toContain(brokerToken);
      for (const access of as.issued.accessTokens) expect(all).not.toContain(access);
      expect(request.headers["x-trent-own-credential"]).toBeUndefined();
    }
    expect(other.requests).toHaveLength(0);
  });

  it("refuses a cross-origin redirect: the other host never receives the OAuth bearer", async () => {
    await setup({ redirectTo: `http://${OTHER_HOST}/mcp` });
    const names = mcpOAuthEnvNames("fake");
    manager.saveSecrets({ [names.access]: "seeded-oauth-bearer-fixture", [names.expiresAt]: new Date(Date.now() + 3600_000).toISOString() });
    await expect(viaProxy(entry({ Authorization: mcpOAuthHeaderTemplate("fake") }))).rejects.toThrow(/redirect/);
    expect(mcp.requests.length).toBeGreaterThan(0);
    expect(other.requests).toHaveLength(0);
  });

  it("refuses a cross-origin redirect for a static Authorization header too", async () => {
    await setup({ redirectTo: `http://${OTHER_HOST}/mcp` });
    await expect(viaProxy(entry({ Authorization: "Bearer ${STATIC_MCP_TOKEN}" }), { STATIC_MCP_TOKEN: "static-bearer-fixture" })).rejects.toThrow(/redirect/);
    expect(mcp.requests.length).toBeGreaterThan(0);
    expect(other.requests.map((r) => r.headers.authorization)).toEqual([]);
  });

  // [C4] The egress fetch now honours `redirect: "manual"`, so every hop is decided by the shared rule
  // (`keepsCredentials`): a same-origin 307 keeps the bearer on the MCP host, and the hop cap still holds.
  it("follows a same-origin redirect on the shared rule with the bearer, and stops at the hop cap", async () => {
    await setup({ redirectTo: `http://${MCP_HOST}/mcp` });
    await expect(viaProxy(entry({ Authorization: "Bearer ${STATIC_MCP_TOKEN}" }), { STATIC_MCP_TOKEN: "static-bearer-fixture" })).rejects.toThrow(/redirected more than 3 times/);
    const hops = mcp.requests;
    expect(hops.length).toBeGreaterThanOrEqual(4);
    for (const hop of hops) expect(hop.headers.authorization).toBe("Bearer static-bearer-fixture");
    expect(other.requests).toHaveLength(0);
  });
  // [/C4]
});
