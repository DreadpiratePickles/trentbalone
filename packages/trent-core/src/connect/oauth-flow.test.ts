/**
 * The loopback OAuth flow, end to end against a local authorization server: a random loopback
 * port, PKCE, a state the callback must echo, the exact redirect URI at both ends, the code
 * exchange, and the tokens landing in the profile secrets file at 0600. The result the flow
 * returns is what the CLI prints, so it is asserted to carry no token.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigManager } from "../config/ConfigManager.js";
import { EXIT, isTrentError } from "../errors/index.js";
import { connectOAuth, refreshOAuth } from "./flow.js";
import { ConnectStore } from "./store.js";
import { FakeOAuthServer, fakeBrowser } from "./testing/fake-oauth-server.js";

const CLIENT_ID = "client-id-oauthflow.apps";
const CLIENT_SECRET = "client-secret-oauthflow-0123456789";

let home: string;
let store: ConnectStore;
let server: FakeOAuthServer;
let manager: ConfigManager;

beforeEach(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trent-connect-flow-")));
  manager = new ConfigManager({ baseDir: home });
  store = new ConnectStore(manager);
  store.writeFields("google", { GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET });
  server = new FakeOAuthServer({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  await server.start();
});

afterEach(async () => {
  await server.stop();
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("GOOGLE_") || name.startsWith("META_") || name.startsWith("SQUARE_")) delete process.env[name];
  }
  fs.rmSync(home, { recursive: true, force: true });
});

const everyIssuedToken = (): string[] => [...server.issued.accessTokens, ...server.issued.refreshTokens, ...server.issued.codes];

async function failure(promise: Promise<unknown>): Promise<{ code: number; message: string }> {
  try {
    await promise;
  } catch (err) {
    if (isTrentError(err)) return { code: err.code, message: err.message };
    throw err;
  }
  throw new Error("expected the flow to fail");
}

describe("the loopback flow", () => {
  it("connects Google: PKCE, state, exact redirect URI, tokens in .env at 0600, no token in the result", async () => {
    const opened: string[] = [];
    const result = await connectOAuth(store, "google", {
      endpoints: server.endpoints,
      openBrowser: (url) => {
        opened.push(url);
        void fakeBrowser(url);
      },
    });

    // The authorization request the browser was sent to.
    expect(opened).toHaveLength(1);
    const authorize = new URL(opened[0] ?? "");
    expect(`${authorize.origin}${authorize.pathname}`).toBe(server.endpoints.authorization);
    expect(authorize.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(authorize.searchParams.get("response_type")).toBe("code");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("access_type")).toBe("offline");
    expect(authorize.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/business.manage");
    const redirectUri = authorize.searchParams.get("redirect_uri") ?? "";
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(authorize.searchParams.get("state") ?? "").toHaveLength(43);

    // The token request: the same redirect URI, the verifier, the secret, a form body.
    expect(server.tokenRequests).toHaveLength(1);
    const exchange = server.tokenRequests[0];
    expect(exchange?.contentType).toContain("application/x-www-form-urlencoded");
    expect(exchange?.body).toMatchObject({ grant_type: "authorization_code", redirect_uri: redirectUri, client_id: CLIENT_ID, client_secret: CLIENT_SECRET });
    expect(exchange?.body.code_verifier).toBeDefined();

    // What is stored, and what is returned.
    expect(result).toMatchObject({ provider: "google", kind: "oauth2", hasRefreshToken: true, redirectUri });
    expect(result.scopes).toEqual(["https://www.googleapis.com/auth/calendar", "https://www.googleapis.com/auth/business.manage"]);
    expect(Date.parse(result.expiresAt ?? "")).toBeGreaterThan(Date.now() + 3000 * 1000);
    for (const secret of everyIssuedToken()) expect(JSON.stringify(result)).not.toContain(secret);

    const secretsPath = manager.getSecretsPath();
    expect(fs.statSync(secretsPath).mode & 0o777).toBe(0o600);
    const body = fs.readFileSync(secretsPath, "utf8");
    expect(body).toContain(`GOOGLE_ACCESS_TOKEN=${server.issued.accessTokens[0]}`);
    expect(body).toContain(`GOOGLE_REFRESH_TOKEN=${server.issued.refreshTokens[0]}`);
    expect(store.read("google")).toMatchObject({ connected: true, hasRefreshToken: true });
  });

  it("refuses a callback whose state is not the one it sent, exchanges nothing and stores nothing", async () => {
    server.tamperState = true;
    let browser: Promise<{ status: number; body: string }> | undefined;

    const failed = await failure(
      connectOAuth(store, "google", {
        endpoints: server.endpoints,
        openBrowser: (url) => {
          browser = fakeBrowser(url);
        },
        timeoutMs: 5000,
      }),
    );

    expect(failed.code).toBe(EXIT.AUTH);
    expect(failed.message).toMatch(/state/i);
    expect((await browser)?.status).toBe(400);
    expect(server.tokenRequests).toHaveLength(0);
    expect(store.read("google").connected).toBe(false);
    for (const secret of everyIssuedToken()) expect(failed.message).not.toContain(secret);
  });

  it("reports a refusal from the provider by its error code and stores nothing", async () => {
    server.denyNext = true;

    const failed = await failure(connectOAuth(store, "google", { endpoints: server.endpoints, openBrowser: (url) => void fakeBrowser(url) }));

    expect(failed.code).toBe(EXIT.AUTH);
    expect(failed.message).toContain("access_denied");
    expect(server.tokenRequests).toHaveLength(0);
    expect(store.read("google").connected).toBe(false);
  });

  it("reports a failed exchange by status and error code, never the body, and stores nothing", async () => {
    server.refuseTokens = true;

    const failed = await failure(connectOAuth(store, "google", { endpoints: server.endpoints, openBrowser: (url) => void fakeBrowser(url) }));

    expect(failed.code).toBe(EXIT.PROVIDER);
    expect(failed.message).toContain("400");
    expect(failed.message).toContain("invalid_grant");
    expect(failed.message).not.toContain("refused by the fake server");
    expect(store.read("google").connected).toBe(false);
  });

  it("gives up when no callback arrives in time", async () => {
    const failed = await failure(connectOAuth(store, "google", { endpoints: server.endpoints, openBrowser: () => undefined, timeoutMs: 200 }));

    expect(failed.code).toBe(EXIT.AUTH);
    expect(failed.message).toMatch(/callback/i);
  });

  it("refuses to start without the client id the user must register, naming the env name", async () => {
    store.writeFields("square", { SQUARE_APPLICATION_ID: "sq0idp-oauthflow" });
    const failed = await failure(connectOAuth(store, "meta", { endpoints: server.endpoints, openBrowser: () => undefined }));

    expect(failed.code).toBe(EXIT.CONFIG);
    expect(failed.message).toContain("META_CLIENT_ID");
    expect(server.authorizeRequests).toHaveLength(0);
  });

  it("honours a fixed port, so a provider that matches the redirect URI exactly can be registered once", async () => {
    const port = 40000 + Math.floor(Math.random() * 20000);
    const result = await connectOAuth(store, "google", { endpoints: server.endpoints, port, openBrowser: (url) => void fakeBrowser(url) });

    expect(result.redirectUri).toBe(`http://127.0.0.1:${port}/callback`);
  });

  it("sends Square a JSON token request on localhost with the verifier and no secret when none is stored", async () => {
    store.writeFields("square", { SQUARE_APPLICATION_ID: CLIENT_ID });
    const square = new FakeOAuthServer({ clientId: CLIENT_ID, expiresAtIso: true, scopeInResponse: false });
    await square.start();
    try {
      const result = await connectOAuth(store, "square", { endpoints: square.endpoints, openBrowser: (url) => void fakeBrowser(url) });

      const exchange = square.tokenRequests[0];
      expect(exchange?.contentType).toContain("application/json");
      expect(exchange?.body).toMatchObject({ grant_type: "authorization_code", client_id: CLIENT_ID });
      expect(exchange?.body.client_secret).toBeUndefined();
      expect(exchange?.body.code_verifier).toBeDefined();
      expect(result.redirectUri).toMatch(/^http:\/\/localhost:\d+\/callback$/);
      // No scope in the response: the requested scopes stand in. `expires_at` is read as-is.
      expect(result.scopes).toEqual([...store.read("square").scopes]);
      expect(result.scopes).toContain("APPOINTMENTS_WRITE");
      expect(Date.parse(result.expiresAt ?? "")).toBeGreaterThan(Date.now());
    } finally {
      await square.stop();
    }
  });

  it("sends Meta comma-separated scopes without PKCE and exchanges the token for a long-lived one on refresh", async () => {
    store.writeFields("meta", { META_CLIENT_ID: CLIENT_ID, META_CLIENT_SECRET: CLIENT_SECRET });
    const meta = new FakeOAuthServer({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, requirePkce: false });
    await meta.start();
    try {
      const opened: string[] = [];
      await connectOAuth(store, "meta", {
        endpoints: meta.endpoints,
        openBrowser: (url) => {
          opened.push(url);
          void fakeBrowser(url);
        },
      });
      const authorize = new URL(opened[0] ?? "");
      expect(authorize.searchParams.get("scope")).toContain("pages_manage_posts,");
      expect(authorize.searchParams.get("code_challenge")).toBeNull();
      const before = store.tokens("meta");

      const refreshed = await refreshOAuth(store, "meta", { endpoints: meta.endpoints });

      const exchange = meta.tokenRequests.at(-1);
      expect(exchange?.body).toMatchObject({ grant_type: "fb_exchange_token", fb_exchange_token: before?.accessToken, client_id: CLIENT_ID, client_secret: CLIENT_SECRET });
      expect(store.tokens("meta")?.accessToken).not.toBe(before?.accessToken);
      expect(Date.parse(refreshed.expiresAt ?? "")).toBeGreaterThan(Date.now() + 50 * 24 * 3600 * 1000);
      expect(JSON.stringify(refreshed)).not.toContain(store.tokens("meta")?.accessToken ?? "never");
    } finally {
      await meta.stop();
    }
  });

  it("refreshes Google with the stored refresh token and keeps it when the provider returns none", async () => {
    await connectOAuth(store, "google", { endpoints: server.endpoints, openBrowser: (url) => void fakeBrowser(url) });
    const before = store.tokens("google");

    const result = await refreshOAuth(store, "google", { endpoints: server.endpoints });

    expect(server.refreshCount).toBe(1);
    expect(server.tokenRequests.at(-1)?.body).toMatchObject({ grant_type: "refresh_token", refresh_token: before?.refreshToken, client_id: CLIENT_ID, client_secret: CLIENT_SECRET });
    const after = store.tokens("google");
    expect(after?.accessToken).not.toBe(before?.accessToken);
    expect(after?.refreshToken).toBe(before?.refreshToken);
    expect(result.hasRefreshToken).toBe(true);
    for (const secret of everyIssuedToken()) expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("refuses to refresh a provider that is not connected", async () => {
    const failed = await failure(refreshOAuth(store, "google", { endpoints: server.endpoints }));
    expect(failed.code).toBe(EXIT.AUTH);
    expect(failed.message).toContain("trent connect google");
  });
});
