/**
 * [H2] RED — OAuth 2.1 for http MCP servers, against the MCP authorization specification revision
 * 2026-07-28, end to end against a fake authorization server and a fake protected MCP server
 * (`__fixtures__/fake-oauth-mcp.ts`). Nothing here talks to a real provider.
 *
 *   discovery     RFC 9728 protected-resource metadata (the challenge's `resource_metadata`, then the
 *                 path-aware and root well-known URIs), RFC 8414 / OIDC discovery in the spec's order,
 *                 the `issuer` identity check, S256 PKCE advertised or refuse, https endpoints
 *   login         RFC 7591 registration of a native public client, RFC 7636 S256 on the `trent connect`
 *                 loopback listener, RFC 8707 `resource` at both ends, RFC 9207 `iss` on the callback
 *   tokens        profile secrets under names derived from the server name, refresh before expiry,
 *                 one refresh and retry on a 401, and a login hint when nothing can be refreshed
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigManager } from "../../config/ConfigManager.js";
import type { McpServerConfig } from "../../config/schema.js";
import { AS_HOST, FakeAuthServer, FakeOAuthMcp, LOOKUP, MCP_HOST, fakeBrowser, routingFetch, type FakeAuthServerOptions, type FakeOAuthMcpOptions } from "./__fixtures__/fake-oauth-mcp.js";
import { connectMcpServer } from "./client.js";
import { createMcpAdapters } from "./index.js";
import { loginMcpServer, type McpLoginDeps } from "./http-oauth.js";
import { McpOAuthStore, mcpOAuthEnvNames, mcpOAuthHeaderTemplate } from "./http-oauth-store.js";
import { authorizationServerMetadataUrls, canonicalResourceUri, discoverAuthorizationServer, discoverProtectedResource, parseBearerChallenge, protectedResourceMetadataUrls } from "./http-oauth-wire.js";

let home: string;
let manager: ConfigManager;
let store: McpOAuthStore;
let as: FakeAuthServer;
let mcp: FakeOAuthMcp;
let routes: Record<string, number>;

async function setup(asOptions: FakeAuthServerOptions = {}, mcpOptions: FakeOAuthMcpOptions = {}): Promise<void> {
  as = new FakeAuthServer(asOptions);
  await as.start();
  mcp = new FakeOAuthMcp(as, mcpOptions);
  await mcp.start();
  routes = { [AS_HOST]: as.port, [MCP_HOST]: mcp.port };
}

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trent-mcp-oauth-")));
  manager = new ConfigManager({ baseDir: home });
  store = new McpOAuthStore(manager);
});

afterEach(async () => {
  await mcp?.stop();
  await as?.stop();
  // `saveSecrets` exports every value into process.env; a later test must not inherit one.
  for (const name of Object.keys(process.env)) if (name.startsWith("MCP_FAKE_")) delete process.env[name];
  fs.rmSync(home, { recursive: true, force: true });
});

function login(server = "fake", extra: Partial<McpLoginDeps> = {}) {
  return loginMcpServer(server, mcp.url, {
    store,
    fetchImpl: routingFetch(routes),
    lookup: LOOKUP,
    openBrowser: (url) => void fakeBrowser(url, routes),
    timeoutMs: 5000,
    ...extra,
  });
}

function entry(headers: Record<string, string> = { Authorization: mcpOAuthHeaderTemplate("fake") }): McpServerConfig {
  return { transport: "http", url: mcp.url, headers, auto_approve: [], enabled: true };
}

function connect(now?: () => Date, config: McpServerConfig = entry()) {
  return connectMcpServer("fake", config, { env: {}, fetchImpl: routingFetch(routes), lookup: LOOKUP, oauth: { store, ...(now === undefined ? {} : { now }) }, redactionLog: () => undefined });
}

const hours = (n: number) => () => new Date(Date.now() + n * 3600_000);
const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

describe("the wire pieces", () => {
  it("parses a Bearer challenge's resource_metadata, scope and error (RFC 6750 section 3, RFC 9728 section 5.1)", () => {
    expect(parseBearerChallenge('Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource", scope="files:read files:write"')).toEqual({
      resourceMetadata: "https://mcp.example.com/.well-known/oauth-protected-resource",
      scope: "files:read files:write",
    });
    expect(parseBearerChallenge('Bearer error="insufficient_scope", scope="files:write"')).toEqual({ error: "insufficient_scope", scope: "files:write" });
    expect(parseBearerChallenge('Basic realm="x"')).toBeUndefined();
    expect(parseBearerChallenge(null)).toBeUndefined();
  });

  it("builds the canonical resource URI (RFC 8707 section 2): lowercase scheme and host, no fragment, no trailing slash", () => {
    expect(canonicalResourceUri("HTTPS://MCP.Example.com/mcp#frag")).toBe("https://mcp.example.com/mcp");
    expect(canonicalResourceUri("https://mcp.example.com/")).toBe("https://mcp.example.com");
    expect(canonicalResourceUri("https://mcp.example.com:8443/server/mcp/")).toBe("https://mcp.example.com:8443/server/mcp");
  });

  it("orders the well-known URIs as the specification requires", () => {
    expect(protectedResourceMetadataUrls("https://example.com/public/mcp")).toEqual([
      "https://example.com/.well-known/oauth-protected-resource/public/mcp",
      "https://example.com/.well-known/oauth-protected-resource",
    ]);
    expect(protectedResourceMetadataUrls("https://example.com")).toEqual(["https://example.com/.well-known/oauth-protected-resource"]);
    expect(authorizationServerMetadataUrls("https://auth.example.com/tenant1")).toEqual([
      "https://auth.example.com/.well-known/oauth-authorization-server/tenant1",
      "https://auth.example.com/.well-known/openid-configuration/tenant1",
      "https://auth.example.com/tenant1/.well-known/openid-configuration",
    ]);
    expect(authorizationServerMetadataUrls("https://auth.example.com")).toEqual([
      "https://auth.example.com/.well-known/oauth-authorization-server",
      "https://auth.example.com/.well-known/openid-configuration",
    ]);
  });

  it("refuses a plain-http authorization server for an https MCP server before any request", async () => {
    let calls = 0;
    const deps = { fetchImpl: (async () => { calls += 1; return new Response("{}"); }) as typeof fetch, lookup: LOOKUP, allowHttp: false };
    await expect(discoverAuthorizationServer("http://auth.example.com", deps)).rejects.toThrow(/https/);
    expect(calls).toBe(0);
  });

  it("refuses a resource_metadata URL the SSRF floor refuses, before any request", async () => {
    let calls = 0;
    const deps = { fetchImpl: (async () => { calls += 1; return new Response("{}"); }) as typeof fetch, lookup: LOOKUP, allowHttp: true };
    await expect(discoverProtectedResource("http://mcp.fake.test/mcp", { resourceMetadata: "http://169.254.169.254/latest/meta-data" }, deps)).rejects.toThrow(/refused/);
    expect(calls).toBe(0);
  });
});

describe("discovery against the fake servers", () => {
  it("probes without a credential, follows resource_metadata from the 401, and takes the challenged scope", async () => {
    await setup();
    await login();
    expect(mcp.mcpRequests[0]?.method).toBe("POST");
    expect(mcp.mcpRequests[0]?.headers.authorization).toBeUndefined();
    expect(mcp.requests.filter((r) => r.method === "GET").map((r) => r.path)).toEqual(["/.well-known/oauth-protected-resource/mcp"]);
    // The challenged scope, plus offline_access because the authorization server lists it.
    expect(as.authorizeRequests[0]?.get("scope")).toBe("mcp:tools offline_access");
  });

  it("without resource_metadata in the challenge, tries the path-aware URI first, then the root", async () => {
    await setup({}, { challengeMetadata: false, prmAt: "root" });
    await login();
    expect(mcp.requests.filter((r) => r.method === "GET").map((r) => r.path)).toEqual(["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]);
  });

  it("refuses protected-resource metadata that names another resource (RFC 9728 section 3.3)", async () => {
    await setup({}, { prmResource: "http://other.fake.test/mcp" });
    await expect(login()).rejects.toThrow(/RFC 9728/);
    expect(as.requests).toHaveLength(0);
  });

  it("finds an issuer with a path through OIDC discovery, after the two URIs that come first", async () => {
    await setup({ issuerPath: "/tenant1", metadataAt: "oidc-appended" });
    await login();
    expect(as.requests.filter((r) => r.method === "GET" && r.path.includes(".well-known")).map((r) => r.path)).toEqual([
      "/.well-known/oauth-authorization-server/tenant1",
      "/.well-known/openid-configuration/tenant1",
      "/tenant1/.well-known/openid-configuration",
    ]);
  });

  it("refuses metadata whose issuer is not the one the URL was built from", async () => {
    await setup({ wrongIssuer: true });
    await expect(login()).rejects.toThrow(/issuer/);
    expect(as.registrations).toHaveLength(0);
  });

  it("refuses an authorization server that does not advertise PKCE", async () => {
    await setup({ pkceMethods: null });
    await expect(login()).rejects.toThrow(/code_challenge_methods_supported/);
    expect(as.registrations).toHaveLength(0);
  });

  it("refuses an authorization server whose PKCE methods do not include S256", async () => {
    await setup({ pkceMethods: ["plain"] });
    await expect(login()).rejects.toThrow(/S256/);
    expect(as.authorizeRequests).toHaveLength(0);
  });
});

describe("the login", () => {
  it("registers a native public client, runs S256 PKCE on the loopback with resource at both ends, and stores names only", async () => {
    await setup();
    const shown: string[] = [];
    const result = await login("fake", { onAuthorizationUrl: (url) => shown.push(url) });

    expect(as.registrations).toHaveLength(1);
    const registration = as.registrations[0]!;
    expect(registration).toMatchObject({ application_type: "native", token_endpoint_auth_method: "none", response_types: ["code"], grant_types: ["authorization_code", "refresh_token"] });
    const redirectUri = (registration.redirect_uris as string[])[0]!;
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

    const authorize = as.authorizeRequests[0]!;
    expect(shown).toHaveLength(1);
    expect(authorize.get("client_id")).toBe(as.issued.clientIds[0]);
    expect(authorize.get("redirect_uri")).toBe(redirectUri);
    expect(authorize.get("code_challenge_method")).toBe("S256");
    expect(authorize.get("resource")).toBe(mcp.url);
    expect(authorize.get("state")).toHaveLength(43);

    const exchange = as.tokenRequests[0]!;
    expect(exchange).toMatchObject({ grant_type: "authorization_code", redirect_uri: redirectUri, resource: mcp.url, client_id: as.issued.clientIds[0] });
    expect(exchange.code_verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(s256(exchange.code_verifier!)).toBe(authorize.get("code_challenge"));
    expect(exchange.client_secret).toBeUndefined();

    const names = mcpOAuthEnvNames("fake");
    expect(names.access).toBe("MCP_FAKE_ACCESS_TOKEN");
    expect(mcpOAuthEnvNames("linear-app").access).toBe("MCP_LINEAR_APP_ACCESS_TOKEN");
    const secrets = fs.readFileSync(manager.getSecretsPath(), "utf8");
    expect(secrets).toContain(`${names.access}=${as.issued.accessTokens[0]}`);
    expect(secrets).toContain(`${names.refresh}=${as.issued.refreshTokens[0]}`);
    expect(fs.statSync(manager.getSecretsPath()).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(manager.getConfigPath())).toBe(false);

    expect(result).toMatchObject({ server: "fake", issuer: as.issuer, resource: mcp.url, registration: "dynamic", hasRefreshToken: true, redirectUri });
    expect(result.written).toContain(names.access);
    const printed = JSON.stringify(result);
    for (const value of [...as.issued.accessTokens, ...as.issued.refreshTokens, ...as.issued.codes, exchange.code_verifier!]) expect(printed).not.toContain(value);
  });

  it("reuses the client it registered on the next login instead of registering again", async () => {
    await setup();
    const first = await login();
    const second = await login();
    expect(as.registrations).toHaveLength(1);
    expect(second.registration).toBe("stored");
    expect(as.authorizeRequests.map((p) => p.get("client_id"))).toEqual([as.issued.clientIds[0], as.issued.clientIds[0]]);
    expect(second.redirectUri).toBe(first.redirectUri);
  });

  it("refuses a callback whose iss is not the recorded issuer, and never sends the code (RFC 9207)", async () => {
    await setup({ issInResponse: "wrong" });
    await expect(login()).rejects.toThrow(/issuer/);
    expect(as.tokenRequests).toHaveLength(0);
  });

  it("refuses a callback without iss when the metadata promised one", async () => {
    await setup({ issInResponse: "absent" });
    await expect(login()).rejects.toThrow(/iss/);
    expect(as.tokenRequests).toHaveLength(0);
  });

  it("refuses an authorization server with no registration endpoint and no client registered with it", async () => {
    await setup({ registration: false });
    await expect(login()).rejects.toThrow(/RFC 7591/);
    expect(as.authorizeRequests).toHaveLength(0);
  });
});

describe("tokens at connect time", () => {
  it("sends the stored bearer to the MCP server", async () => {
    await setup();
    await login();
    const before = mcp.mcpRequests.length;
    const connection = await connect();
    expect((await connection.callTool("echo", { text: "hi" })).text).toBe("echo: hi");
    await connection.close();
    const sent = mcp.mcpRequests.slice(before).map((r) => r.headers.authorization);
    expect(sent.length).toBeGreaterThan(2);
    expect(new Set(sent)).toEqual(new Set([`Bearer ${as.issued.accessTokens[0]}`]));
  });

  it("refreshes an expired access token before the MCP server sees it, with resource, and stores the rotated refresh token", async () => {
    await setup();
    await login();
    const [firstRefresh] = as.issued.refreshTokens;
    const before = mcp.mcpRequests.length;
    const connection = await connect(hours(2));
    expect((await connection.callTool("echo", { text: "hi" })).text).toBe("echo: hi");
    await connection.close();
    const refreshes = as.tokenRequests.filter((r) => r.grant_type === "refresh_token");
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]).toMatchObject({ refresh_token: firstRefresh, resource: mcp.url, client_id: as.issued.clientIds[0] });
    expect(new Set(mcp.mcpRequests.slice(before).map((r) => r.headers.authorization))).toEqual(new Set([`Bearer ${as.issued.accessTokens[1]}`]));
    const secrets = fs.readFileSync(manager.getSecretsPath(), "utf8");
    expect(secrets).toContain(`${mcpOAuthEnvNames("fake").refresh}=${as.issued.refreshTokens[1]}`);
    expect(secrets).not.toContain(firstRefresh!);
  });

  it("answers a 401 to a stored token with one refresh and one retry", async () => {
    await setup();
    await login();
    as.revoke(as.issued.accessTokens[0]!);
    const connection = await connect();
    expect((await connection.callTool("echo", { text: "again" })).text).toBe("echo: again");
    await connection.close();
    expect(as.tokenRequests.filter((r) => r.grant_type === "refresh_token")).toHaveLength(1);
  });

  it("an OAuth server that was never logged in is unavailable with the login command, and receives nothing", async () => {
    await setup();
    await expect(connect()).rejects.toThrow("trent mcp test fake --oauth");
    expect(mcp.requests).toHaveLength(0);
  });

  it("a server configured without a credential that answers 401 with a Bearer challenge names the login command", async () => {
    await setup();
    await expect(connect(undefined, entry({}))).rejects.toThrow(/401.*trent mcp test fake --oauth/);
  });

  it("an expired token with no refresh token is reported expired, with the login command", async () => {
    await setup();
    await login();
    manager.saveSecrets({ [mcpOAuthEnvNames("fake").refresh]: "" });
    await expect(connect(hours(2))).rejects.toThrow(/expired.*trent mcp test fake --oauth/);
  });
});

describe("the seat path", () => {
  it("an adapter built with only a profile directory reads that profile's token, default and named alike", async () => {
    await setup();
    for (const profile of ["default", "work"]) {
      const profileManager = new ConfigManager({ baseDir: home, profile });
      await login("fake", { store: new McpOAuthStore(profileManager) });
      const built = await createMcpAdapters(
        { mcp_servers: { fake: entry() } },
        { profileDir: profileManager.getProfileDir(), env: {}, fetchImpl: routingFetch(routes), lookup: LOOKUP, redactionLog: () => undefined },
      );
      expect(built.unavailable, profile).toEqual([]);
      const result = await built.adapters[0]!.execute('mcp_fake_echo {"text":"seat"}', {});
      expect(result.status, profile).toBe("completed");
      await built.adapters[0]!.cleanup();
      const last = mcp.mcpRequests.at(-1)?.headers.authorization;
      expect(last, profile).toBe(`Bearer ${as.issued.accessTokens.at(-1)}`);
    }
  });
});

describe("status", () => {
  it("is needs-login, then connected, then expired (refreshable or not), and never carries a value", async () => {
    await setup();
    expect(store.status("fake", new Date()).state).toBe("needs-login");
    await login();
    const connected = store.status("fake", new Date());
    expect(connected).toMatchObject({ state: "connected", refreshable: true, issuer: as.issuer });
    expect(store.status("fake", hours(2)())).toMatchObject({ state: "expired", refreshable: true });
    manager.saveSecrets({ [mcpOAuthEnvNames("fake").refresh]: "" });
    expect(store.status("fake", hours(2)())).toMatchObject({ state: "expired", refreshable: false });
    const printed = JSON.stringify(store.status("fake", new Date()));
    for (const value of [...as.issued.accessTokens, ...as.issued.refreshTokens]) expect(printed).not.toContain(value);
  });
});
